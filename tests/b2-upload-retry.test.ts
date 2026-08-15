import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function loadB2Client(): Promise<any> {
  const url = pathToFileURL(path.join(process.cwd(), "distribution", "b2", "b2-client.mjs")).href;
  return import(url);
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function drain(req: http.IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("error", reject);
  });
}

test("B2 publisher retries transient 5xx uploads with a fresh upload URL and exponential backoff", async () => {
  const b2 = await loadB2Client();
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-b2-retry-"));
  const file = path.join(root, "payload.txt");
  const data = Buffer.from("retry-me");
  const sha1 = createHash("sha1").update(data).digest("hex");
  await writeFile(file, data);

  let base = "";
  let uploadUrlRequests = 0;
  let uploadAttempts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/b2api/v4/b2_get_upload_url") {
      await drain(req);
      uploadUrlRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        uploadUrl: `${base}/upload/${uploadUrlRequests}`,
        authorizationToken: `upload-token-${uploadUrlRequests}`,
      }));
      return;
    }
    if (req.url?.startsWith("/upload/")) {
      await drain(req);
      uploadAttempts += 1;
      if (uploadAttempts <= 2) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "service_unavailable", message: "no tomes available" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contentSha1: sha1 }));
      return;
    }
    res.writeHead(404).end();
  });

  const delays: number[] = [];
  try {
    base = await listen(server);
    const auth = { authorizationToken: "auth", storage: { apiUrl: base } };
    const result = await b2.uploadFileWithRetry(auth, "bucket-id", "releases/test/payload.txt", file, {
      maxAttempts: 5,
      baseDelayMs: 1,
      onRetry: ({ delayMs }: { delayMs: number }) => delays.push(delayMs),
    });
    assert.equal(result.contentSha1, sha1);
    assert.equal(uploadAttempts, 3);
    assert.equal(uploadUrlRequests, 3, "every retry must discard the old upload URL and acquire a fresh one");
    assert.deepEqual(delays, [1, 2]);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("B2 publisher does not retry non-5xx upload failures", async () => {
  const b2 = await loadB2Client();
  const root = await mkdtemp(path.join(os.tmpdir(), "openai-cc-b2-no-retry-"));
  const file = path.join(root, "payload.txt");
  await writeFile(file, "do-not-retry");

  let base = "";
  let uploadUrlRequests = 0;
  let uploadAttempts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/b2api/v4/b2_get_upload_url") {
      await drain(req);
      uploadUrlRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ uploadUrl: `${base}/upload`, authorizationToken: "upload-token" }));
      return;
    }
    if (req.url === "/upload") {
      await drain(req);
      uploadAttempts += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "unauthorized", message: "bad upload token" }));
      return;
    }
    res.writeHead(404).end();
  });

  try {
    base = await listen(server);
    const auth = { authorizationToken: "auth", storage: { apiUrl: base } };
    await assert.rejects(
      () => b2.uploadFileWithRetry(auth, "bucket-id", "releases/test/payload.txt", file, { maxAttempts: 5, baseDelayMs: 1 }),
      /bad upload token/
    );
    assert.equal(uploadAttempts, 1);
    assert.equal(uploadUrlRequests, 1);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

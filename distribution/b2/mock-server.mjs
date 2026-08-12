import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { createServer } from "node:http";

const root = process.env.DIST_ROOT;
const port = Number(process.env.DIST_PORT || "18094");
const bucketId = process.env.DIST_BUCKET_ID || "bucket-ci";
const bucketName = process.env.DIST_BUCKET_NAME || "openai-cc-ci";
const releasePrefix = process.env.DIST_RELEASE_PREFIX;
if (!root || !releasePrefix) throw new Error("DIST_ROOT and DIST_RELEASE_PREFIX are required.");
mkdirSync(root, { recursive: true });

const credentials = new Map([
  ["ci-valid-id:ci-valid-key", "valid"],
  ["ci-expired-id:ci-expired-key", "expired"],
  ["ci-overbroad-id:ci-overbroad-key", "overbroad"],
  ["ci-publish-id:ci-publish-key", "publisher"],
  ["ci-issuer-id:ci-issuer-key", "issuer"],
]);
const generatedByCredential = new Map();
const generatedById = new Map();
const issuedDownloadTokens = new Map();
let generatedCounter = 0;
let interruptedRangedDownload = false;

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(data.length) });
  res.end(data);
}

function basicCredential(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;
  try { return Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return null; }
}

async function bodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  const data = await bodyBuffer(req);
  try { return data.length ? JSON.parse(data.toString("utf8")) : {}; } catch { throw new Error("invalid JSON body"); }
}

function authResponse(mode, generated = null) {
  const base = {
    accountId: "account-ci",
    authorizationToken: "",
    applicationKeyExpirationTimestamp: null,
    apiInfo: {
      storageApi: {
        apiUrl: `http://127.0.0.1:${port}`,
        downloadUrl: `http://127.0.0.1:${port}`,
        allowed: { buckets: [], capabilities: [], namePrefix: null },
      },
    },
  };

  if (generated) {
    const token = `download-${generated.applicationKeyId}`;
    issuedDownloadTokens.set(token, generated.namePrefix);
    base.authorizationToken = token;
    base.applicationKeyExpirationTimestamp = generated.expirationTimestamp;
    base.apiInfo.storageApi.allowed = {
      buckets: [{ id: bucketId, name: bucketName }],
      capabilities: ["readFiles"],
      namePrefix: generated.namePrefix,
    };
    return base;
  }

  if (mode === "publisher") {
    base.authorizationToken = "account-publisher";
    base.apiInfo.storageApi.allowed = {
      buckets: [{ id: bucketId, name: bucketName }],
      capabilities: ["writeFiles"],
      namePrefix: "releases/",
    };
    return base;
  }
  if (mode === "issuer") {
    base.authorizationToken = "account-issuer";
    base.apiInfo.storageApi.allowed = {
      buckets: [],
      capabilities: ["writeKeys", "deleteKeys"],
      namePrefix: null,
    };
    return base;
  }

  const expiration = mode === "expired" ? Date.now() - 60_000 : Date.now() + 15 * 60_000;
  base.authorizationToken = `download-${mode}`;
  base.applicationKeyExpirationTimestamp = expiration;
  base.apiInfo.storageApi.allowed = {
    buckets: [{ id: bucketId, name: bucketName }],
    capabilities: mode === "overbroad" ? ["readFiles", "writeFiles"] : ["readFiles"],
    namePrefix: releasePrefix,
  };
  return base;
}

function safeLeaf(fileName) {
  if (!fileName.startsWith(releasePrefix)) return null;
  const leaf = fileName.slice(releasePrefix.length);
  if (!leaf || leaf.includes("/") || leaf.includes("\\") || leaf === "." || leaf === "..") return null;
  return leaf;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === "/b2api/v4/b2_authorize_account") {
      const credential = basicCredential(req);
      const generated = generatedByCredential.get(credential);
      if (generated) return json(res, 200, authResponse("generated", generated));
      const mode = credentials.get(credential);
      if (!mode) return json(res, 401, { code: "unauthorized", message: "invalid or revoked application key" });
      return json(res, 200, authResponse(mode));
    }

    if (url.pathname === "/b2api/v4/b2_get_upload_url") {
      if (req.headers.authorization !== "account-publisher") return json(res, 401, { code: "unauthorized" });
      const body = await jsonBody(req);
      if (body.bucketId !== bucketId) return json(res, 400, { code: "bad_bucket_id" });
      return json(res, 200, {
        bucketId,
        uploadUrl: `http://127.0.0.1:${port}/b2api/v4/b2_upload_file`,
        authorizationToken: "upload-token",
      });
    }

    if (url.pathname === "/b2api/v4/b2_upload_file") {
      if (req.headers.authorization !== "upload-token") return json(res, 401, { code: "unauthorized" });
      const encodedName = String(req.headers["x-bz-file-name"] || "");
      let fileName;
      try { fileName = decodeURIComponent(encodedName); } catch { return json(res, 400, { code: "bad_file_name" }); }
      const leaf = safeLeaf(fileName);
      if (!leaf) return json(res, 403, { code: "access_denied", message: "outside release prefix" });
      const data = await bodyBuffer(req);
      const sha1 = createHash("sha1").update(data).digest("hex");
      if (String(req.headers["x-bz-content-sha1"] || "").toLowerCase() !== sha1) return json(res, 400, { code: "bad_digest" });
      writeFileSync(join(root, leaf), data);
      return json(res, 200, {
        accountId: "account-ci",
        action: "upload",
        bucketId,
        contentLength: data.length,
        contentSha1: sha1,
        fileId: `file-${leaf}`,
        fileName,
      });
    }

    if (url.pathname === "/b2api/v4/b2_create_key") {
      if (req.headers.authorization !== "account-issuer") return json(res, 401, { code: "unauthorized" });
      const body = await jsonBody(req);
      const ttl = Number(body.validDurationInSeconds);
      if (body.accountId !== "account-ci" || JSON.stringify(body.capabilities) !== JSON.stringify(["readFiles"]) || JSON.stringify(body.bucketIds) !== JSON.stringify([bucketId]) || body.namePrefix !== releasePrefix || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
        return json(res, 400, { code: "bad_request", message: "unexpected grant scope" });
      }
      generatedCounter += 1;
      const applicationKeyId = `ci-generated-${generatedCounter}`;
      const applicationKey = `ci-generated-secret-${generatedCounter}`;
      const generated = {
        applicationKeyId,
        applicationKey,
        expirationTimestamp: Date.now() + ttl * 1000,
        namePrefix: body.namePrefix,
        keyName: body.keyName,
      };
      generatedByCredential.set(`${applicationKeyId}:${applicationKey}`, generated);
      generatedById.set(applicationKeyId, generated);
      return json(res, 200, {
        accountId: "account-ci",
        applicationKeyId,
        applicationKey,
        bucketIds: [bucketId],
        capabilities: ["readFiles"],
        expirationTimestamp: generated.expirationTimestamp,
        keyName: body.keyName,
        namePrefix: body.namePrefix,
        options: [],
      });
    }

    if (url.pathname === "/b2api/v4/b2_delete_key") {
      if (req.headers.authorization !== "account-issuer") return json(res, 401, { code: "unauthorized" });
      const body = await jsonBody(req);
      const generated = generatedById.get(body.applicationKeyId);
      if (!generated) return json(res, 400, { code: "bad_request", message: "unknown key" });
      generatedById.delete(generated.applicationKeyId);
      generatedByCredential.delete(`${generated.applicationKeyId}:${generated.applicationKey}`);
      return json(res, 200, {
        accountId: "account-ci",
        applicationKeyId: generated.applicationKeyId,
        bucketIds: [bucketId],
        capabilities: ["readFiles"],
        expirationTimestamp: generated.expirationTimestamp,
        keyName: generated.keyName,
        namePrefix: generated.namePrefix,
        options: [],
      });
    }

    const filePrefix = `/file/${encodeURIComponent(bucketName)}/`;
    if (url.pathname.startsWith(filePrefix)) {
      const auth = String(req.headers.authorization || "");
      let authorizedPrefix = null;
      if (auth === "download-valid" || auth === "download-overbroad") authorizedPrefix = releasePrefix;
      else authorizedPrefix = issuedDownloadTokens.get(auth) || null;
      if (!authorizedPrefix) return json(res, 401, { code: "unauthorized", message: "invalid download authorization token" });

      const encodedName = url.pathname.slice(filePrefix.length);
      const fileName = encodedName.split("/").map((part) => decodeURIComponent(part)).join("/");
      if (!fileName.startsWith(authorizedPrefix)) return json(res, 403, { code: "access_denied", message: "outside allowed prefix" });
      const leaf = fileName.slice(releasePrefix.length);
      if (!leaf || leaf.includes("/") || leaf.includes("\\") || leaf === "." || leaf === "..") return json(res, 404, { code: "not_found" });
      const path = normalize(join(root, leaf));
      if (!existsSync(path) || !statSync(path).isFile()) return json(res, 404, { code: "not_found" });
      const size = statSync(path).size;
      const sha1 = createHash("sha1").update(readFileSync(path)).digest("hex");
      const range = String(req.headers.range || "").match(/^bytes=(\d+)-(\d+)$/);
      if (!range) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(size),
          "x-bz-content-sha1": sha1,
          "cache-control": "no-store",
        });
        createReadStream(path).pipe(res);
        return;
      }
      const start = Number(range[1]);
      const requestedEnd = Number(range[2]);
      const end = Math.min(requestedEnd, size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      // Production B2 returns the complete object with 200 when a range from
      // byte zero covers a small file, while larger partial ranges return 206.
      if (start === 0 && requestedEnd >= size - 1) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(size),
          "accept-ranges": "bytes",
          "x-bz-content-sha1": sha1,
          "cache-control": "no-store",
        });
        createReadStream(path).pipe(res);
        return;
      }
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "x-bz-content-sha1": sha1,
        "cache-control": "no-store",
      });
      if (process.env.DIST_INTERRUPT_RANGED_ONCE === "1" && !interruptedRangedDownload && start > 0) {
        interruptedRangedDownload = true;
        const partial = readFileSync(path).subarray(start, Math.min(end + 1, start + 65_536));
        res.write(partial);
        res.destroy();
        return;
      }
      createReadStream(path, { start, end }).pipe(res);
      return;
    }

    json(res, 404, { code: "not_found" });
  } catch (error) {
    json(res, 500, { code: "fixture_error", message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`READY ${port}`));

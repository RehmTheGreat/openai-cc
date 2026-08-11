import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { createServer } from "node:http";

const root = process.env.DIST_ROOT;
const port = Number(process.env.DIST_PORT || "18094");
const bucketId = process.env.DIST_BUCKET_ID || "bucket-ci";
const bucketName = process.env.DIST_BUCKET_NAME || "openai-cc-ci";
const releasePrefix = process.env.DIST_RELEASE_PREFIX;
if (!root || !releasePrefix) throw new Error("DIST_ROOT and DIST_RELEASE_PREFIX are required.");

const credentials = new Map([
  ["ci-valid-id:ci-valid-key", "valid"],
  ["ci-expired-id:ci-expired-key", "expired"],
  ["ci-overbroad-id:ci-overbroad-key", "overbroad"],
]);

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

function authResponse(mode) {
  const expiration = mode === "expired" ? Date.now() - 60_000 : Date.now() + 15 * 60_000;
  return {
    authorizationToken: `download-${mode}`,
    applicationKeyExpirationTimestamp: expiration,
    apiInfo: {
      storageApi: {
        apiUrl: `http://127.0.0.1:${port}`,
        downloadUrl: `http://127.0.0.1:${port}`,
        allowed: {
          buckets: [{ id: bucketId, name: bucketName }],
          capabilities: mode === "overbroad" ? ["readFiles", "writeFiles"] : ["readFiles"],
          namePrefix: releasePrefix,
        },
      },
    },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname === "/b2api/v4/b2_authorize_account") {
    const credential = basicCredential(req);
    const mode = credentials.get(credential);
    if (!mode) return json(res, 401, { code: "unauthorized", message: "invalid or revoked application key" });
    return json(res, 200, authResponse(mode));
  }

  const filePrefix = `/file/${encodeURIComponent(bucketName)}/`;
  if (url.pathname.startsWith(filePrefix)) {
    const auth = req.headers.authorization;
    if (auth !== "download-valid" && auth !== "download-overbroad") {
      return json(res, 401, { code: "unauthorized", message: "invalid download authorization token" });
    }
    const encodedName = url.pathname.slice(filePrefix.length);
    const fileName = encodedName.split("/").map((part) => decodeURIComponent(part)).join("/");
    if (!fileName.startsWith(releasePrefix)) return json(res, 403, { code: "access_denied", message: "outside allowed prefix" });
    const leaf = fileName.slice(releasePrefix.length);
    if (!leaf || leaf.includes("/") || leaf.includes("\\") || leaf === "." || leaf === "..") return json(res, 404, { code: "not_found" });
    const path = normalize(join(root, leaf));
    if (!existsSync(path) || !statSync(path).isFile()) return json(res, 404, { code: "not_found" });
    const sha1 = createHash("sha1");
    const { readFileSync } = await import("node:fs");
    sha1.update(readFileSync(path));
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(statSync(path).size),
      "x-bz-content-sha1": sha1.digest("hex"),
      "cache-control": "no-store",
    });
    createReadStream(path).pipe(res);
    return;
  }

  json(res, 404, { code: "not_found" });
});

server.listen(port, "127.0.0.1", () => console.log(`READY ${port}`));

import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createServer } from "node:http";

const root = process.env.DIST_ROOT;
const expectedToken = process.env.DIST_TOKEN;
const port = Number(process.env.DIST_PORT || "18092");
if (!root || !expectedToken) throw new Error("DIST_ROOT and DIST_TOKEN are required");

const allowed = new Set([
  "bootstrap.ps1",
  "install.ps1",
  "openai-cc-runtime-manifest.json",
]);

for (const entry of process.env.DIST_EXTRA_FILES?.split(";") || []) {
  if (entry) allowed.add(entry);
}

const server = createServer((req, res) => {
  if (req.headers["deploy-token"] !== expectedToken) {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
    return;
  }

  const name = basename(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  if (!allowed.has(name)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  const path = join(root, name);
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(statSync(path).size),
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`READY ${port}`);
});

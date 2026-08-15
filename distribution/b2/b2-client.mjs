import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

function isLoopbackUrl(value) {
  const url = new URL(value);
  return ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
}

export function authorizeUrl() {
  const override = process.env.OPENAI_CC_B2_AUTHORIZE_URL;
  if (!override) return DEFAULT_AUTHORIZE_URL;
  if (!isLoopbackUrl(override)) {
    throw new Error("OPENAI_CC_B2_AUTHORIZE_URL may only override Backblaze with a loopback HTTP(S) URL for local CI tests.");
  }
  return override;
}

export function basicAuth(applicationKeyId, applicationKey) {
  if (!applicationKeyId || !applicationKey) throw new Error("Backblaze application key ID and key are required.");
  return `Basic ${Buffer.from(`${applicationKeyId}:${applicationKey}`, "utf8").toString("base64")}`;
}

async function checkedJson(response, action) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { }
  if (!response.ok) {
    const detail = body?.message || body?.code || text || `HTTP ${response.status}`;
    const error = new Error(`${action} failed: ${detail}`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  if (!body || typeof body !== "object") throw new Error(`${action} returned invalid JSON.`);
  return body;
}

export async function authorize(applicationKeyId, applicationKey) {
  const response = await fetch(authorizeUrl(), {
    method: "GET",
    headers: { Authorization: basicAuth(applicationKeyId, applicationKey) },
  });
  const body = await checkedJson(response, "B2 authorization");
  const storage = body?.apiInfo?.storageApi;
  if (!body.authorizationToken || !storage?.apiUrl || !storage?.downloadUrl || !storage?.allowed) {
    throw new Error("B2 authorization response is missing storage API metadata.");
  }
  return { ...body, storage };
}

export async function apiJson(auth, operation, payload) {
  const url = `${auth.storage.apiUrl.replace(/\/$/, "")}/b2api/v4/${operation}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return checkedJson(response, operation);
}

export async function sha1File(path) {
  const data = await readFile(path);
  return createHash("sha1").update(data).digest("hex");
}

export async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

export async function uploadFile(uploadUrl, uploadAuthorizationToken, fileName, path) {
  const data = await readFile(path);
  const sha1 = createHash("sha1").update(data).digest("hex");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: uploadAuthorizationToken,
      "X-Bz-File-Name": encodeURIComponent(fileName).replace(/%2F/gi, "/"),
      "Content-Type": "b2/x-auto",
      "Content-Length": String(data.length),
      "X-Bz-Content-Sha1": sha1,
    },
    body: data,
  });
  const body = await checkedJson(response, `B2 upload ${fileName}`);
  if (String(body.contentSha1 || "").toLowerCase() !== sha1) {
    throw new Error(`B2 upload SHA-1 verification failed for ${fileName}.`);
  }
  return body;
}

export function isRetryableB2ServerError(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadFileWithRetry(auth, bucketId, fileName, path, options = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : null;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("B2 upload maxAttempts must be an integer from 1 to 10.");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("B2 upload baseDelayMs must be a non-negative number.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // Upload URLs are disposable. Acquire a fresh one for every attempt so a
      // transient 5xx from a single B2 storage tome is never reused.
      const upload = await apiJson(auth, "b2_get_upload_url", { bucketId });
      if (!upload.uploadUrl || !upload.authorizationToken) {
        throw new Error("b2_get_upload_url returned incomplete upload metadata.");
      }
      return await uploadFile(upload.uploadUrl, upload.authorizationToken, fileName, path);
    } catch (error) {
      if (!isRetryableB2ServerError(error) || attempt === maxAttempts) throw error;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      onRetry?.({ attempt, nextAttempt: attempt + 1, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error(`B2 upload ${fileName} exhausted retry attempts.`);
}

export function requireExactCapabilities(allowed, expected) {
  const actual = [...(allowed?.capabilities || [])].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Backblaze key capabilities must be exactly ${wanted.join(", ")}; got ${actual.join(", ") || "none"}.`);
  }
}

export function requireBucketScope(allowed, bucketId, namePrefix) {
  const buckets = Array.isArray(allowed?.buckets) ? allowed.buckets : [];
  if (buckets.length !== 1 || buckets[0]?.id !== bucketId) {
    throw new Error("Backblaze key must be restricted to exactly the configured distribution bucket.");
  }
  if (String(allowed?.namePrefix || "") !== namePrefix) {
    throw new Error(`Backblaze key must be restricted to prefix '${namePrefix}'.`);
  }
}

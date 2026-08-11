import { readFile, writeFile } from 'node:fs/promises';
async function edit(file, from, to){const s=await readFile(file,'utf8');if(!s.includes(from))throw new Error(`Missing anchor in ${file}`);await writeFile(file,s.replace(from,to),'utf8');}
await edit('src/account-store.ts',
`function sanitizeError(value: string, exactSecrets: string[] = []): string {
  let safe = String(value ?? "");
  for (const secret of exactSecrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/https?:\\/\\/\\S+/gi, "[redacted-url]")
    .replace(/\\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key|authorization)\\b\\s*[:=]\\s*[^\\s,]+/gi, "$1=[redacted]")
    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]")
    .slice(0, 1000);
}`,
`function sanitizeError(value: string, exactSecrets: string[] = []): string {
  let safe = String(value ?? "")
    .replace(/https?:\\/\\/\\S+/gi, "[redacted-url]")
    .replace(/\\b(?:access_token|refresh_token|id_token|code|code_verifier|state|api_key|authorization)\\b\\s*[:=]\\s*[^\\s,]+/gi, "$1=[redacted]")
    .replace(/\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b/g, "[redacted-jwt]");
  for (const secret of exactSecrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe.slice(0, 1000);
}`);
await edit('src/provider-registry.ts',
`function redact(value:string,exactSecret?:string):string{let safe=String(value);if(exactSecret)safe=safe.split(exactSecret).join("[redacted]");return safe.replace(/\\bBearer\\s+[^\\s,;]+/gi,"Bearer [redacted]").replace(/\\bsk-[A-Za-z0-9_-]{8,}/g,"[redacted]").replace(/\\bAIza[A-Za-z0-9_-]{20,}/g,"[redacted]").slice(0,800);}`,
`function redact(value:string,exactSecret?:string):string{let safe=String(value).replace(/\\bBearer\\s+[^\\s,;]+/gi,"Bearer [redacted]").replace(/\\bsk-[A-Za-z0-9_-]{8,}/g,"[redacted]").replace(/\\bAIza[A-Za-z0-9_-]{20,}/g,"[redacted]");if(exactSecret)safe=safe.split(exactSecret).join("[redacted]");return safe.slice(0,800);}`);
console.log('Redaction order fixed.');

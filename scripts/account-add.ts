import { AccountStore } from "../src/account-store.js";
import { AuthJob, OfficialCodexAuthRunner } from "../src/chatgpt-auth.js";

const args = parseArgs(process.argv.slice(2));
const id = args.id;
const name = args.name || id;
if (!id) {
  console.error('Usage: npm run account:add -- --id alice --name "Alice" [--reauth] [--device-auth]');
  process.exit(2);
}

const store = new AccountStore(process.env.DATA_DIR || ".data");
await store.init();
const runner = new OfficialCodexAuthRunner(store);
let currentJobId: string | undefined;
process.once("SIGINT", () => {
  if (currentJobId) void runner.cancel(currentJobId).finally(() => process.exit(130));
  else process.exit(130);
});

try {
  let job = await runner.start({
    credentialId: id,
    displayName: name,
    mode: args.reauth === "true" ? "reauth" : "create",
    loginMode: args["device-auth"] === "true" ? "device" : "browser",
  });
  currentJobId = job.jobId;
  let last = "";
  let lastDevice = "";
  while (!terminal(job)) {
    const message = `${job.status}: ${job.safeMessage ?? ""}`.trim();
    if (message !== last) { console.log(message); last = message; }
    if (job.verificationUrl && job.userCode) {
      const device = `Open: ${job.verificationUrl}\nOne-time code: ${job.userCode}`;
      if (device !== lastDevice) { console.log(device); lastDevice = device; }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    job = runner.status(job.jobId);
  }
  if (job.status !== "complete") {
    console.error(job.safeError ?? job.safeMessage ?? `Authentication ${job.status}.`);
    process.exitCode = job.status === "cancelled" ? 130 : 1;
  } else {
    console.log(`Added ${job.displayName} (${job.credentialId})${job.email ? ` <${job.email}>` : ""}.`);
  }
} finally {
  currentJobId = undefined;
  await runner.shutdown();
  store.close();
}

function terminal(job: AuthJob): boolean {
  return job.status === "complete" || job.status === "cancelled" || job.status === "error";
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = "true";
  }
  return out;
}

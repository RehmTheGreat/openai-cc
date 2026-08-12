import path from "node:path";
import { AccountStore } from "../src/account-store.js";
import {
  createChatGptOAuthBoundary,
  requireSuccessfulChatGptResponse,
} from "../src/chatgpt-oauth.js";
import { anthropicToFccResponses } from "../src/fcc-responses.js";
import { AnthropicRequest, OpenAIToolNameCodec } from "../src/translator.js";

const args = parseArgs(process.argv.slice(2));
const model = args.model ?? "gpt-5.6-terra";
const root = path.resolve(process.env.OPENAI_CC_HOME || process.cwd());
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, ".data"));
const store = new AccountStore(dataDir);
await store.init();

try {
  const credentialId = args.credential
    ?? store.orderedReady("chatgpt")[0]?.id;
  if (!credentialId) throw new Error(`No ChatGPT credential found in ${dataDir}. Add or re-authenticate one first.`);
  const account = store.get(credentialId);
  if (!account || account.provider !== "chatgpt" || !account.authFile) {
    throw new Error(`Credential ${credentialId} is not a usable ChatGPT OAuth credential.`);
  }

  console.log("OpenAI-CC Codex doctor");
  console.log(`installRoot: ${root}`);
  console.log(`dataDir: ${dataDir}`);
  console.log(`credential: ${credentialId}${account.email ? ` (${account.email})` : ""}`);
  console.log(`model: ${model}`);

  const boundary = createChatGptOAuthBoundary(account.authFile);

  await stage("1/4 model catalog", async () => {
    const models = await boundary.listModels();
    if (!models.includes(model)) {
      throw new Error(`${model} is not present in this account's Codex model catalog. Visible GPT models: ${models.filter((id) => id.startsWith("gpt-")).join(", ") || "<none>"}`);
    }
    console.log(`  ${model} is visible (${models.length} public Codex models).`);
  });

  await stage("2/4 Evan-direct Responses", async () => {
    const request = {
      model,
      stream: false,
      input: "Reply with exactly: openai-cc-direct-ok",
    };
    const response = await requireSuccessfulChatGptResponse(await boundary.responses(request), request);
    const payload = await response.json() as any;
    if (payload?.status !== "completed") {
      throw new Error(`Codex returned HTTP 200 but response status was ${JSON.stringify(payload?.status ?? "<missing>")}.`);
    }
    const inputTokens = Number(payload?.usage?.input_tokens ?? 0);
    const outputTokens = Number(payload?.usage?.output_tokens ?? 0);
    if (!(inputTokens > 0) || !(outputTokens > 0)) {
      throw new Error(`Codex returned HTTP 200/completed but invalid usage: input=${inputTokens}, output=${outputTokens}.`);
    }
    const outputTypes = Array.isArray(payload?.output)
      ? payload.output.map((item: any) => String(item?.type ?? "unknown"))
      : [];
    const text = outputText(payload);
    const textNote = text ? ` text=${JSON.stringify(text.slice(0, 120))}` : "";
    console.log(`  HTTP 200 completed; usage ${inputTokens}/${outputTokens}; output types ${outputTypes.join(", ") || "<none>"}.${textNote}`);
  });

  await stage("3/4 FCC-translated Claude request", async () => {
    const anthropic: AnthropicRequest = {
      model: "claude-opus-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "Reply with exactly: openai-cc-translated-ok" }],
      stream: false,
    };
    const codec = OpenAIToolNameCodec.fromRequest(anthropic);
    const request = { ...anthropicToFccResponses(anthropic, codec), model, stream: false } as Record<string, unknown>;
    const response = await requireSuccessfulChatGptResponse(await boundary.responses(request), request);
    const payload = await response.json();
    const text = outputText(payload);
    if (!text) throw new Error("Codex returned HTTP 200 but no output_text for the translated request.");
    console.log(`  HTTP 200: ${JSON.stringify(text.slice(0, 120))}`);
  });

  await stage("4/4 Claude-style tools request", async () => {
    const anthropic: AnthropicRequest = {
      model: "claude-opus-5",
      max_tokens: 512,
      system: [{ type: "text", text: "You are a coding agent. Use tools when explicitly requested." }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [{
        name: "diagnostic_echo",
        description: "Echo a diagnostic value.",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }],
      tool_choice: { type: "tool", name: "diagnostic_echo" },
      messages: [{ role: "user", content: "Call diagnostic_echo with value openai-cc-tools-ok." }],
      stream: false,
    };
    const codec = OpenAIToolNameCodec.fromRequest(anthropic);
    const request = { ...anthropicToFccResponses(anthropic, codec), model, stream: false } as Record<string, unknown>;
    const response = await requireSuccessfulChatGptResponse(await boundary.responses(request), request);
    const payload = await response.json() as any;
    const outputTypes = Array.isArray(payload?.output)
      ? payload.output.map((item: any) => String(item?.type ?? "unknown"))
      : [];
    console.log(`  HTTP 200: output types ${outputTypes.join(", ") || "<none>"}.`);
  });

  console.log("\nPASS: ChatGPT OAuth, Terra, FCC translation, and Claude-style tools all reached Codex successfully.");
} catch (error: any) {
  const message = error?.message ?? String(error);
  console.error(`\nFAIL: ${message}`);
  process.exitCode = isUsageLimited(message) ? 2 : 1;
} finally {
  store.close();
}

function isUsageLimited(message: string): boolean {
  return /\bHTTP 429\b|usage limit|rate[- ]limit/i.test(message);
}

async function stage(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  await fn();
  console.log("  PASS");
}

function outputText(payload: any): string {
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .flatMap((item: any) => item?.type === "message" && Array.isArray(item.content) ? item.content : [])
    .filter((item: any) => item?.type === "output_text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("")
    .trim();
}

function parseArgs(values: string[]): { credential?: string; model?: string } {
  const out: { credential?: string; model?: string } = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--credential" && values[index + 1]) out.credential = values[++index];
    else if (values[index] === "--model" && values[index + 1]) out.model = values[++index];
  }
  return out;
}

import { AccountStore } from "./account-store.js";
import { createServer } from "./dispatcher.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8082);
const store = new AccountStore(process.env.DATA_DIR || ".data");
await store.init();

const server = createServer(store);
server.listen(port, host, () => {
  console.log(`Anthropic-compatible endpoint: http://${host}:${port}`);
  console.log(`Admin panel: http://${host}:${port}/admin`);
  console.log(`Active account: ${store.active()?.name ?? "none"}`);
});

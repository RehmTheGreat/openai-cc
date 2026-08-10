import { AccountStore } from "../src/account-store.js";
const store = new AccountStore(process.env.DATA_DIR || ".data");
await store.init();
console.table(store.list().map((a) => ({
  id: a.id,
  name: a.name,
  email: a.email ?? "",
  status: a.status,
  active: store.active()?.id === a.id,
  firstRequestAt: a.firstRequestAt ?? "",
  limitResetsAt: a.limitResetsAt ?? "",
  authFile: a.authFile,
})));

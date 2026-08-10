import { AccountStore } from "../src/account-store.js";
const store = new AccountStore(process.env.DATA_DIR || ".data");
await store.init();
console.table(store.list().map((a) => ({ id: a.id, name: a.name, status: a.status, active: store.active()?.id === a.id, authFile: a.authFile })));

import { AccountStore } from "../src/account-store.js";

const store = new AccountStore(process.env.DATA_DIR || ".data");
await store.init();
const snapshot = store.snapshot();
console.table(snapshot.accounts.map((credential) => ({
  id: credential.id,
  name: credential.name,
  provider: credential.provider,
  email: credential.email ?? "",
  model: credential.model ?? "",
  status: credential.status,
  preferred: snapshot.preferredCredentialByProvider[credential.provider] === credential.id,
  firstRequestAt: credential.firstRequestAt ?? "",
  limitResetsAt: credential.limitResetsAt ?? "",
})));
store.close();

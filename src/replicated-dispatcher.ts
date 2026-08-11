// Compatibility shim for pre-Session-5 imports. Production code uses dispatcher.ts.
export { Dispatcher as ReplicatedDispatcher, createServer as createReplicatedServer } from "./dispatcher.js";
export type { DispatcherOptions } from "./dispatcher.js";

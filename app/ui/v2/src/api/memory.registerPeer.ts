import { type Bank } from "./memory";
import { call } from "./memory.call";

export const registerPeer = (b: Bank, peer_name: string) => call(b, "registerPeer", { peer_name });

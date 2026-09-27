import { type Bank } from "./memory";
import { call } from "./memory.call";

export const getPeer = (b: Bank, peer_name: string) => call(b, "getPeer", { peer_name });

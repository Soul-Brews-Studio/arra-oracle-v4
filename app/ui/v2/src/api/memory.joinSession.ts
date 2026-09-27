import { type Bank } from "./memory";
import { call } from "./memory.call";

export const joinSession = (b: Bank, session_name: string, peer_name: string) =>
  call(b, "joinSession", { session_name, peer_name });

import { type Bank } from "./memory";
import { call } from "./memory.call";

export const getReadCursor = (b: Bank, peer_name: string, session_name: string) =>
  call(b, "getReadCursor", { peer_name, session_name });

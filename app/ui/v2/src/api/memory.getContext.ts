import { type Bank } from "./memory";
import { call } from "./memory.call";

export const getContext = (b: Bank, peer_name: string, session_name: string, max_items = 20) =>
  call(b, "getContext", { peer_name, session_name, max_items });

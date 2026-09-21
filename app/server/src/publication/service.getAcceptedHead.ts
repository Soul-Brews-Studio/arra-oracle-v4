import { failPublication } from "./errors";
import { parseReadRequest } from "./service.parseReadRequest";
import { readHeadAndAncestry } from "./service.readHeadAndAncestry";
import { type DatasetAdapter } from "./service.types";

export async function getAcceptedHead(reader: DatasetAdapter, requestBytes: Uint8Array) {
const request = parseReadRequest(requestBytes);
      const found = await readHeadAndAncestry(reader, request);
      if (found === null) return null; // absent node: exactly null
      const head = found.ancestry.encoded.at(-1);
      if (head === undefined) failPublication("integrity_failure");
      return { node: found.node, revision: head };
}

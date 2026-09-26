import { failPublication } from "./errors";
import { parseReadRequest } from "./service.parseReadRequest";
import { readHeadAndAncestry } from "./service.readHeadAndAncestry";
import { terminalEventsFor } from "./service.evaluateEligibility";
import { type DatasetAdapter } from "./service.types";

/**
 * #29 slice B: `lifecycle` is an ADDITIVE label (analysis-29.json fix plan
 * B4) -- a retired or superseded node stays readable here, exactly as
 * before, only now clearly labelled instead of indistinguishable from an
 * active one. `null` means the node carries no terminal event.
 */
export async function getAcceptedHead(reader: DatasetAdapter, requestBytes: Uint8Array) {
const request = parseReadRequest(requestBytes);
      const found = await readHeadAndAncestry(reader, request);
      if (found === null) return null; // absent node: exactly null
      const head = found.ancestry.encoded.at(-1);
      if (head === undefined) failPublication("integrity_failure");
      const lifecycle = (await terminalEventsFor(reader, request.workspace_name, [request.node_id])).get(
        request.node_id,
      ) ?? null;
      return { node: found.node, revision: head, lifecycle };
}

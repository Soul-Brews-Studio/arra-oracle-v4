// Split from protocol.ts (style-split4b, 2026-09-28): protocolVersion negotiation.
//
// A client sends the revision it speaks. Echo it back when we recognise its era,
// fall back to our newest known one otherwise. NEVER hard-code one and reject the
// rest -- see protocol.ts's header note for the incident this avoids.
import { KNOWN_PROTOCOL_VERSIONS } from "./protocol.state";

export function negotiate(asked: unknown): string {
  const want = String(asked ?? "");
  return (KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(want)
    ? want
    : KNOWN_PROTOCOL_VERSIONS[0];
}

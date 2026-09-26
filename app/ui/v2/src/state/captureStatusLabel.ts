import type { AssociationLinkRow } from "../api/evidenceReview";
import type { EvidenceLabel } from "./evidenceStatus.types";

/** A link's `capture_status` as a badge (#33 AC3). The three values are
 *  `contracts/revision-v1.ts`'s `CAPTURE_STATUSES`, and per
 *  association-evidence-v1 §3 they are "retained claims, not live access
 *  checks": what the citing author recorded when citing, which is why every
 *  `detail` below says "when cited". An unknown value is shown verbatim as a
 *  problem rather than dropped -- a status this client does not understand
 *  must not render as if it were fine. */
export function captureStatusLabel(
  link: Pick<AssociationLinkRow, "capture_status" | "captured_at" | "content_hash">,
): EvidenceLabel {
  switch (link.capture_status) {
    case "captured":
      return {
        text: "captured",
        tone: "ok",
        detail:
          `content captured when cited${link.captured_at !== null ? ` at ${link.captured_at}` : " (no capture time recorded)"}` +
          (link.content_hash !== null ? `; content_hash ${link.content_hash.slice(0, 12)}…` : ""),
      };
    case "locator_only":
      return {
        text: "locator only",
        tone: "warn",
        detail: "only the locator was recorded when cited; no content was captured to check it against",
      };
    case "unresolved":
      return {
        text: "unresolved",
        tone: "bad",
        detail: "the citing author could not resolve this target when citing it",
      };
    default:
      return {
        text: `capture status: ${link.capture_status}`,
        tone: "bad",
        detail: "not a capture status this UI knows; shown verbatim rather than treated as captured",
      };
  }
}

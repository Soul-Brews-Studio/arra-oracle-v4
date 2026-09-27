import { LINK_RELATIONS } from "../api/knowledge";
import { CITE_TARGET_FIELDS, CITE_TARGET_KINDS, type LinkDraft } from "./linkDraft.types";

const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

/** Fields that must be a caller-minted nanoid21 (`common.ts` isNanoid21). */
const ID_FIELDS = new Set(["node_id", "revision_id", "message_public_id"]);

/** `contracts/evidence-v1.ts` requireUrl, client side: the same passive check,
 *  no fetch. The original string is what gets sent, never `URL`'s rewrite. */
function urlProblem(raw: string): string | null {
  if (raw === "") return "url is required";
  if (raw !== raw.trim() || /[\u0000- \u007f\\]/.test(raw)) {
    return "url must not contain spaces, control characters or backslashes";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "url does not parse";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url must be http or https";
  if (parsed.hostname === "") return "url needs a host";
  if (parsed.username !== "" || parsed.password !== "") return "url must not carry credentials";
  return null;
}

/** Every problem with one editor row that the server would refuse by SHAPE,
 *  each naming its field. Whether the target EXISTS is still the server's
 *  call (`invalid_reference`), and the form shows that refusal verbatim. */
export function validateLinkDraft(draft: LinkDraft): string[] {
  const problems: string[] = [];
  if (!(LINK_RELATIONS as readonly string[]).includes(draft.relation)) {
    problems.push(`relation "${draft.relation}" is not one of ${LINK_RELATIONS.join(", ")}`);
  }
  if (!(CITE_TARGET_KINDS as readonly string[]).includes(draft.target_kind)) {
    problems.push(`target kind "${draft.target_kind}" is not offered here`);
    return problems;
  }
  for (const field of CITE_TARGET_FIELDS[draft.target_kind]) {
    const value = draft.fields[field] ?? "";
    if (field === "url") {
      const problem = urlProblem(value);
      if (problem !== null) problems.push(problem);
    } else if (ID_FIELDS.has(field)) {
      if (!NANOID21.test(value)) problems.push(`${field} must be a 21-character id`);
    } else if (value === "") {
      problems.push(`${field} is required`);
    }
  }
  return problems;
}

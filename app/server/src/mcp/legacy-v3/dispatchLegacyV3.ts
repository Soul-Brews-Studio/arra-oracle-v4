import type { ToolOperations } from "../../auth/service";
import type { KnowledgeAccess } from "../../knowledge/transport";
import { indexProfile } from "../../knowledge/transport.indexProfile";
import { availability } from "./availability";
import { V3_CATALOGUE } from "./catalogue";
import { CompatError } from "./compat-error";
import { fromKernel } from "./compat-error.fromKernel";
import { createKb } from "./createKb";
import { V3_HANDLERS } from "./handlers";

/** A2: the route bank is the only scope, so these argument keys are refused. */
const CARRIERS = ["workspace_name", "bank", "workspace", "tenantId", "tenant_id", "tenant", "orgId", "org_id"] as const;

const isEnvelope = (error: unknown): error is { code: string; path: string; toJSON(): unknown } =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  typeof (error as { path?: unknown }).path === "string" &&
  typeof (error as { toJSON?: unknown }).toJSON === "function";

/**
 * Run one v3-family tool (docs/overnight/V3-PARITY.md §2-§3). The service has
 * already admitted `name` under the action the catalogue declares (and
 * resolved an `arra_*` alias to it); this owns only v3 argument translation
 * and v3 output shaping, through `kb()`.
 */
export async function dispatchLegacyV3(
  name: string,
  args: Record<string, unknown>,
  ops: ToolOperations,
  access: KnowledgeAccess | null,
): Promise<unknown> {
  for (const key of CARRIERS) {
    if (Object.hasOwn(args, key)) {
      throw new CompatError(name, "unsupported_argument", `Invalid input at /${key}: scope comes from the connection`,
        "the bank in the URL is the only scope; tenant and workspace arguments are refused", { path: `/${key}` });
    }
  }
  const spec = V3_CATALOGUE.find((tool) => tool.name === name);
  if (spec === undefined) throw new Error("unknown tool");
  const available = availability(name, access);
  if (!available.ok) {
    throw new CompatError(name, "not_yet_available", `${name} is not available in this v4 build yet`, available.detail);
  }

  // A2: cwd is never scope; it is dropped and named, not silently ignored.
  const warnings: { code: string; field: string; detail: string }[] = [];
  let input = args;
  if (Object.hasOwn(args, "cwd")) {
    input = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "cwd"));
    warnings.push({ code: "argument_ignored", field: "cwd", detail: "cwd does not prove project ownership; pass project" });
  }

  const kb = createKb({ spec, bank: ops.bank, authority: ops.authority, access });
  let result: unknown;
  try {
    result = await V3_HANDLERS[name]!(input, {
      tool: name,
      bank: ops.bank,
      kb,
      assertedPeer: ops.assertedPeer,
      authority: ops.authority,
      indexProfile: access?.indexProfile ?? indexProfile(),
    });
  } catch (error) {
    if (error instanceof CompatError) throw error;
    if (isEnvelope(error)) throw fromKernel(name, error);
    throw error;
  }
  if (warnings.length > 0 && typeof result === "object" && result !== null && !Array.isArray(result)) {
    const shaped = result as Record<string, unknown>;
    const prior = Array.isArray(shaped.compat_warnings) ? shaped.compat_warnings : [];
    return { ...shaped, compat_warnings: [...prior, ...warnings] };
  }
  return result;
}

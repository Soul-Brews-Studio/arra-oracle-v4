import type { McpEnvelope, OperationService } from "../auth/service.createOperationService";
import { knowledgeAccessState } from "./index.state";
import { dispatchTool } from "./index.dispatchTool";
import { err, ok, text } from "./protocol";
import { TOOLS } from "./tools";
import { isAdvertised } from "./tools.isAdvertised";
import { V3_TOOLS } from "./legacy-v3/catalogue";

export type McpOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "denied"; readonly code: string };

export function createMcpAdapter(service: OperationService) {
  return async function handle(
    bank: string,
    authorization: string | null,
    readEnvelope: () => Promise<McpEnvelope | null>,
    userAgent = "",
    /** A7/D8: the X-Arra-Peer header, grammar-checked by the route; the service binds it. */
    assertedPeer: string | null = null,
  ): Promise<McpOutcome> {
    if (!bank?.trim()) return { kind: "denied", code: "invalid_scope" };

    // Envelope id is only known after the body is read, which the service does
    // lazily AFTER projection; replies before that point carry a null id.
    let envelopeId: string | number | null = null;
    const capturingReader = async () => {
      const envelope = await readEnvelope();
      envelopeId = envelope?.id ?? null;
      return envelope;
    };

    // The tool -> action map is owned by the service; passing one from here
    // would let the adapter choose which grant a tool required.
    const result = await service.runMcp(authorization, bank, capturingReader, dispatchTool, userAgent, assertedPeer);

    switch (result.kind) {
      case "denied":
        return { kind: "denied", code: result.code };
      case "tools": {
        // Catalogue ORDER preserved; only tools whose action was admitted AND
        // that this deployment can serve (#31: nothing proposed is advertised).
        const visible = [...TOOLS, ...V3_TOOLS].filter(
          (tool) => result.names.includes(tool.name) && isAdvertised(tool.name, knowledgeAccessState.current),
        );
        return { kind: "response", response: Response.json(ok(envelopeId, { tools: visible })) };
      }
      case "method_not_found":
        return { kind: "response", response: Response.json(err(envelopeId, -32601, "method not found")) };
      case "tool_error":
        return {
          kind: "response",
          response: Response.json(ok(envelopeId, { ...text(result.message), isError: true })),
        };
      case "ok":
        return { kind: "response", response: Response.json(ok(envelopeId, text(result.value))) };
    }
  };
}

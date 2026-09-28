import type { KnowledgeAccess } from "../knowledge/transport";
import { knowledgeAccessState } from "./index.state";

export function configureKnowledgeAccess(access: KnowledgeAccess | null): void {
  knowledgeAccessState.current = access;
}

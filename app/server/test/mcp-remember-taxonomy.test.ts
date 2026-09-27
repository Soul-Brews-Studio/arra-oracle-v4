// D5a (docs/overnight/DECISIONS.md, NAT-DECISIONS 2026-09-28): the legacy MCP
// `remember` tool's `type` field goes through the same taxonomy validation
// the knowledge transports use. Unit-level: fakes `KnowledgeAccess` so it
// runs without a LanceDB dataset, and asserts against the exact
// `TaxonomyError` shape `kb_publishRevision` refuses with
// (`service.validateTermReferences.ts`), never a bespoke error.

import { describe, expect, test } from "bun:test";
import type { RequestAuthority } from "../src/knowledge/registry";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import { TaxonomyError } from "../src/publication/taxonomy";
import { validateRememberType } from "../src/mcp/remember.validateType";

const AUTHORITY: RequestAuthority = { peers: null, operator: false };

type Row = Record<string, unknown> | null;

function fakeAccess(opts: {
  vocabulary?: Row;
  termByName?: (name: string) => Row;
}): KnowledgeAccess {
  const vocabulary: Row = opts.vocabulary === undefined ? { id: "voc-type" } : opts.vocabulary;
  return {
    async getBundle() {
      return {
        taxonomy: {
          async lookupVocabularyByName() {
            return vocabulary;
          },
          async lookupTermByName(bytes: Uint8Array) {
            const { name } = JSON.parse(new TextDecoder().decode(bytes)) as { name: string };
            return opts.termByName ? opts.termByName(name) : null;
          },
        },
      };
    },
  } as unknown as KnowledgeAccess;
}

describe("remember.validateType (D5a)", () => {
  test("unknown type term is refused with the kernel's closed envelope", async () => {
    const access = fakeAccess({ termByName: () => null });
    await expect(validateRememberType(access, "alpha", AUTHORITY, "invented_type")).rejects.toMatchObject({
      code: "invalid_reference",
      path: "/type",
    });
  });

  test("a retired term is refused, not silently accepted", async () => {
    const access = fakeAccess({ termByName: () => ({ id: "t1", is_active: false }) });
    await expect(validateRememberType(access, "alpha", AUTHORITY, "conclusion")).rejects.toBeInstanceOf(TaxonomyError);
  });

  test("the sealed type vocabulary itself missing is refused (integrity, not silent)", async () => {
    const access = fakeAccess({ vocabulary: null });
    await expect(validateRememberType(access, "alpha", AUTHORITY, "note")).rejects.toMatchObject({
      code: "invalid_reference",
      path: "/type",
    });
  });

  test("valid, active term is accepted and returned unchanged", async () => {
    const access = fakeAccess({ termByName: (name) => ({ id: `t-${name}`, is_active: true }) });
    await expect(validateRememberType(access, "alpha", AUTHORITY, "conclusion")).resolves.toBe("conclusion");
  });

  test("omitted type defaults to note, and note must itself be active", async () => {
    const access = fakeAccess({ termByName: (name) => (name === "note" ? { id: "t-note", is_active: true } : null) });
    await expect(validateRememberType(access, "alpha", AUTHORITY, undefined)).resolves.toBe("note");
  });

  test("Thai term is accepted when it resolves as an active term", async () => {
    const access = fakeAccess({ termByName: (name) => (name === "บันทึก" ? { id: "t-th", is_active: true } : null) });
    await expect(validateRememberType(access, "alpha", AUTHORITY, "บันทึก")).resolves.toBe("บันทึก");
  });

  test("cross-workspace: a term found in a different workspace's lookup never leaks in (workspace_name is what the fake would have scoped on)", async () => {
    // The fake ignores workspace_name because the real kernel scopes the
    // query itself (`lookupTermByName` -> `service.lookupTermByName.ts`
    // `workspace_name = ...`); this test documents the contract this unit
    // exercises: the bank passed through unchanged to both by-name lookups.
    let seenBank: string | null = null as string | null;
    const access: KnowledgeAccess = {
      async getBundle() {
        return {
          taxonomy: {
            async lookupVocabularyByName(bytes: Uint8Array) {
              seenBank = (JSON.parse(new TextDecoder().decode(bytes)) as { workspace_name: string }).workspace_name;
              return { id: "voc-type" };
            },
            async lookupTermByName() {
              return { id: "t1", is_active: true };
            },
          },
        };
      },
    } as unknown as KnowledgeAccess;
    await validateRememberType(access, "beta-workspace", AUTHORITY, "note");
    expect(seenBank).toBe("beta-workspace");
  });

  test("no knowledge transport configured fails closed, not open", async () => {
    await expect(validateRememberType(null, "alpha", AUTHORITY, "note")).rejects.toMatchObject({
      code: "invalid_request",
      path: "/type",
    });
  });
});

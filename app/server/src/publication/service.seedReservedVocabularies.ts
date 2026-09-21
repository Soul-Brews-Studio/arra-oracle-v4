import { SEED_TERM_ORDER, TERM_FIELDS, VOCABULARY_FIELDS, encodeTermRow, encodeVocabularyRow, failTaxonomy, parseSeedRequest, seedTermRows, seedVocabularyRows } from "./taxonomy";
import { type TaxonomyBoundary } from "./service.boundaries";
import { TERMS, VOCABULARIES } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { lookupTermByName } from "./service.lookupTermByName";
import { lookupVocabularyById } from "./service.lookupVocabularyById";
import { lookupVocabularyByName } from "./service.lookupVocabularyByName";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { sameExcept } from "./service.sameExcept";
import { type Clock, type DatasetAdapter, type OwnerCore, type TaxonomyRow } from "./service.types";
import { writeTaxonomyRow } from "./service.writeTaxonomyRow";

export function seedReservedVocabularies(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock }, requestBytes: Uint8Array) {
async function seedReserved(requestBytes: Uint8Array) {
    const request = parseSeedRequest(requestBytes);
    const workspace = request.workspace_name;
    await requireTaxonomyWorkspaceRow(writer, workspace);
    await writer.refresh(VOCABULARIES);
    await writer.refresh(TERMS);

    const now = options.clock();
    const wantVocabularies = seedVocabularyRows(request, now);
    const wantTerms = seedTermRows(request, now);

    // ---- Preflight the ENTIRE manifest before mutating anything.
    const resolved: Array<{
      table: string;
      want: TaxonomyRow;
      stored: TaxonomyRow | null;
      pointer: string;
    }> = [];

    // Each row's EXACT manifest pointer. Reporting a horizon collision at
    // /type/terms sends a caller to the wrong field entirely.
    const termPointer = (name: string): string =>
      (SEED_TERM_ORDER.indexOf(name as never) < 5 ? "/type/terms/" : "/memory_horizon/terms/") + name;

    for (const want of wantTerms) {
      const pointer = termPointer(want.name as string);
      const stored = await lookupTermById(writer, workspace, want.id as string);
      // Uniqueness is checked REGARDLESS of whether the ID already matches.
      // A matching ID does not excuse a different row holding the same scoped
      // name: the contract asks for full validation even on the satisfied
      // path, and returning already-satisfied over a duplicate would report a
      // corrupt dataset as healthy.
      const byName = await lookupTermByName(writer, 
        workspace,
        want.vocabulary_id as string,
        want.name as string,
      );
      if (byName !== null && byName.id !== want.id) failTaxonomy("conflict", pointer);

      if (stored !== null) {
        const encoded = encodeTermRow(stored);
        // A staged term whose vocabulary_id differs from the supplied manifest
        // CONFLICTS. It is never transferred or adopted into this manifest.
        if (!sameExcept(encoded, encodeTermRow(want), TERM_FIELDS)) {
          failTaxonomy("conflict", pointer);
        }
        resolved.push({ table: TERMS, want, stored: encoded, pointer });
        continue;
      }
      resolved.push({ table: TERMS, want, stored: null, pointer });
    }

    for (const want of wantVocabularies) {
      const pointer = `/${want.name as string}/vocabulary_id`;
      const stored = await lookupVocabularyById(writer, workspace, want.id as string);
      const byName = await lookupVocabularyByName(writer, workspace, want.name as string);
      if (byName !== null && byName.id !== want.id) failTaxonomy("conflict", pointer);

      if (stored !== null) {
        const encoded = encodeVocabularyRow(stored);
        if (!sameExcept(encoded, encodeVocabularyRow(want), VOCABULARY_FIELDS)) {
          failTaxonomy("conflict", pointer);
        }
        resolved.push({ table: VOCABULARIES, want, stored: encoded, pointer });
        continue;
      }
      resolved.push({ table: VOCABULARIES, want, stored: null, pointer });
    }

    // ---- Stage ONLY what is missing, in literal manifest order: the seven
    // terms first, then the two vocabularies. Matching rows are skipped
    // without rewriting them or resampling their clocks, and emit NO
    // mutation boundaries at all.
    let wroteAny = false;
    for (const entry of resolved) {
      if (entry.stored !== null) continue;
      const success: TaxonomyBoundary =
        entry.table === TERMS ? "after_term_write" : "after_vocabulary_write";
      await writeTaxonomyRow(writer, core, entry.table, entry.want, success, wroteAny);
      wroteAny = true;
    }

    // ---- Final all-row verification. Mandatory, covered by the operation-wide
    // post-write guard, and deliberately emitting no after_readback of its own
    // so the trace stays one triple per mutated row.
    const verify = async () => {
      await writer.refresh(VOCABULARIES);
      await writer.refresh(TERMS);
      const terms: TaxonomyRow[] = [];
      const vocabularies: TaxonomyRow[] = [];
      // Expected state per row: an existing row keeps its own retained
      // created_at, a newly staged one carries the allocation time we wrote.
      const expectedFor = (entry: (typeof resolved)[number], encode: (r: TaxonomyRow) => TaxonomyRow) =>
        entry.stored ?? encode(entry.want);

      for (const entry of resolved) {
        const isTerm = entry.table === TERMS;
        const stored = isTerm
          ? await lookupTermById(writer, workspace, entry.want.id as string)
          : await lookupVocabularyById(writer, workspace, entry.want.id as string);
        if (stored === null) failTaxonomy("recovery_required");
        const encoded = isTerm ? encodeTermRow(stored) : encodeVocabularyRow(stored);
        const expected = expectedFor(entry, isTerm ? encodeTermRow : encodeVocabularyRow);
        // Re-CHECK equality. Decoding alone would accept a row that was
        // corrupted after it was written and verified.
        for (const field of isTerm ? TERM_FIELDS : VOCABULARY_FIELDS) {
          if (encoded[field] !== expected[field]) failTaxonomy("recovery_required");
        }
        (isTerm ? terms : vocabularies).push(encoded);
      }
      return { vocabularies, terms };
    };
    const rows = wroteAny ? await core.afterWrite(verify) : await verify();

    return {
      // `created` means THIS call appended at least one row. A resumed seed can
      // therefore return created without having created every row it returns.
      outcome: wroteAny ? ("created" as const) : ("already_satisfied" as const),
      vocabularies: rows.vocabularies,
      terms: rows.terms,
    };
  }

return mutateTaxonomyWrite(core, async () => seedReserved(requestBytes));
}

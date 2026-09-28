// Split from transport.ts (style-split4b, 2026-09-28).
//
// Writer ownership (#31 constraint 3): this combined HTTP+MCP process is the
// SOLE writer of the configured `ARRA_KNOWLEDGE_DATASET_ROOT`. The writer
// bundle is opened LAZILY, on the first accepted write request, and cached
// for the lifetime of the process — never reopened per request, and never
// closed by a route handler, because closing mid-serve would release the
// fd-42 flock while other requests still believe they hold it. Any other
// process that needs this dataset (a CLI invocation, a second server
// instance, a test) must not run concurrently in writer mode; it may always
// open `openKnowledgeReader` / `openEvidenceReader`, which take no gate at
// all. A future CLI writer must be started only while this server is stopped,
// or must be pointed at a different dataset root.
//
// Chat (#32 slice A, overnight ruling R9): `answerChat` persists nothing, so
// it runs on the READER bundle's `chat` facade, composed here with the
// configured model. No request path opens, closes or releases a writer --
// the per-request "ephemeral writer" that chat used to take is gone, because
// in one gated process it both contended for the single owner slot and, on
// close, released the process's only inherited writer gate.
import { randomBytes } from "node:crypto";
import { openEvidenceReader, openEvidenceWriter } from "../publication/service";
import { createChatService } from "../publication/service.createChatService";
import type { KnowledgeAction, KnowledgeBundle, KnowledgeReaderBundle } from "./registry";
import { indexProfile } from "./transport.indexProfile";
import type { KnowledgeDatasetConfig } from "./transport.state";

const NANOID21_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Mint a nanoid21. Modulo bias against 256 is harmless here: these are
 *  allocation identifiers, not a security boundary. */
function randomNanoid21(): string {
  const raw = randomBytes(21);
  let out = "";
  for (let i = 0; i < 21; i++) out += NANOID21_ALPHABET[raw[i]! % NANOID21_ALPHABET.length];
  return out;
}

/**
 * The one process-lifetime cache. Reads are gateless and cheap to open
 * eagerly; the persisting writer is opened lazily on first use and never
 * released by a request path (see file header: writer-ownership decision).
 *
 * The reader bundle carries the `chat` facade, built over that reader's own
 * `getContext` with the configured model, so every chat call is a read; and
 * its context facade carries the #30 searches, opened with the configured
 * query embedder, so every search is a read too.
 */
export function createKnowledgeAccess(config: KnowledgeDatasetConfig) {
  let reader: Promise<KnowledgeReaderBundle> | null = null;
  let writer: Promise<Omit<import("../publication/service").EvidenceWriterBundle, "close">> | null = null;
  const chatOptions = { model: config.chat?.model, settings: config.chat?.settings ?? null };

  const requireRoot = (): string => {
    if (config.datasetRoot === undefined) {
      throw new (class extends Error {
        readonly code = "unsupported_dataset";
        readonly path = "";
        toJSON() {
          return {
            version: "arra-publication-error/v1",
            code: "unsupported_dataset",
            path: "",
            message: "unsupported target dataset",
          };
        }
      })();
    }
    return config.datasetRoot;
  };

  /** Trusted operator configuration for the one cached writer -- never
   *  request data. No model travels here any more (#32 / R9), and no query
   *  embedder either (#30): both are READER composition. What does travel
   *  here is the embed worker's document embedder and R20's digest probe:
   *  `embedPendingChunks` writes vectors, so it is writer composition. */
  const writerOptions = () => ({
    newRevisionId: randomNanoid21,
    clock: Date.now,
    env: config.env ?? process.env,
    // Trusted operator configuration, not request data: this transport
    // exposes local intake only. A namespaced source feed is a future
    // deployment decision, not something a caller's bytes can select.
    sourceNamespace: null,
    documentEmbedder: config.documentEmbedder,
    digestProbe: config.digestProbe,
  });

  return {
    /** Advertising only (#31): false hides kb_* and the v3 family from tools/list. */
    datasetConfigured: config.datasetRoot !== undefined,
    /** Server-chosen chunk-index settings for adapter writes (R18 V1). */
    indexProfile: indexProfile(),

    async getBundle(action: KnowledgeAction): Promise<KnowledgeBundle> {
      // Every action except `content:write` is a READ (#94 widened
      // `KnowledgeAction` to add `audit:read`): branching on `!== "content:write"`
      // rather than `=== "content:read"` keeps this exhaustive as read actions
      // are added, instead of silently routing a new read action into the
      // writer-gate path below, which would require a writer for a call that
      // never mutates anything and could deadlock a reader-only deployment.
      // `answerChat` (#32 / R9) and the #30 searches are among these reads.
      if (action !== "content:write") {
        reader ??= openEvidenceReader(requireRoot(), { embedder: config.embedder }).then((bundle) =>
          Object.freeze({ ...bundle, chat: createChatService(bundle.context, chatOptions) }),
        );
        return reader;
      }
      // Write path: cache only a SUCCESSFUL open. A failed attempt (writer
      // gate not yet available) must be retryable on the next request rather
      // than poisoning every future write for the rest of the process.
      if (writer === null) {
        const attempt = openEvidenceWriter(requireRoot(), writerOptions());
        attempt.catch(() => {
          if (writer === attempt) writer = null;
        });
        writer = attempt;
      }
      return writer;
    },
  };
}

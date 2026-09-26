# LanceDB facts measured 2026-09-26 (evidence for #105, #75, #102, #30, #7, #10)

Measured by the nexus LanceDB research session (pane `w63:p1`, AI) on request from
v4-overnight, in a fresh `mktemp -d`:
`@lancedb/lancedb` 0.38.0 + `apache-arrow` 18.1.0, Bun 1.3.14, macOS arm64.
Schema `Field("ts", new TimestampMicrosecond(), false)`, readback confirmed
`Timestamp<MICROSECOND>` nullable=false. `STORED_us` was read from the raw
`BigInt64Array` behind the Arrow column
(`toArrow().batches[].getChild("ts").data[0].values`), i.e. the true on-disk value.

## 1 · Reading a `timestamp[us]` column returns fractional milliseconds

```text
  written as     STORED_us               JS value from toArray()     typeof
  number-ms      1789982519383921        1789982519383.921           number
  Date           1789982519383000        1789982519383               number
  number-us      1789982519383920896     1789982519383921            number
```

Always a plain JS `number` in **milliseconds**, fractional when the value has
sub-millisecond digits. Never a `Date`, never a `bigint`.

Consequence for #105: any validator that demands a safe integer from a
`timestamp[us]` read rejects every value with sub-ms precision. The correct
conversion is `BigInt(Math.round(ms * 1000))`, which is exact while `ms * 1000`
stays below 2^53. Real epoch values do: about 1.79e15 µs, against a limit of 9.0e15.

## 2 · Writing exact microseconds

Pass a **float number of milliseconds**, i.e. `us / 1000`. Measured exact.

| passed to `add()` | result |
|---|---|
| `1789982519383.921` (ms float) | stored `1789982519383921` exactly |
| `new Date(1789982519383.921)` | stored `1789982519383000`: **921 µs silently lost** |
| `1789982519383921n` (bigint) | throws `Invalid mix of BigInt and other type in multiplication` |
| `1789982519383921` (µs as number) | stored `1789982519383920896`: **silently wrong by 1104 µs**, no error |

Arrow-js multiplies by 1000 internally, which is why bigint cannot pass and raw µs
overflows 2^53.

## 3 · FTS base tokenizers (`Index.fts({ baseTokenizer })`)

A real FTS index over 3 Thai/English rows:

```text
  simple      INDEX OK   hits(ภาษา)=0  hits(ความ)=0
  whitespace  INDEX OK   hits(ภาษา)=0  hits(ความ)=0
  raw         INDEX OK   hits(ภาษา)=0  hits(ความ)=0
  ngram       INDEX OK   hits(ภาษา)=1  hits(ความ)=1   (min=max=3, no folding/stem)
  icu         INDEX OK   hits(ภาษา)=1  hits(ความ)=1
  icu/split   INDEX OK   hits(ภาษา)=1  hits(ความ)=1
  bogus       FAIL  Invalid input, unknown base tokenizer bogus
```

- `icu` segments unsegmented Thai with no pre-pass.
- `ngram` gives substring matching, still BM25-ranked. It is not a literal
  substring baseline; that is the FM index over raw bytes.
- The #10 comment of 2026-09-22 measured that `trigram` and `unicode61` are refused.
  That is still true. `icu` is the working replacement SPEC §4.1.2 should name.

## 4 · Install trap

`@lancedb/lancedb` 0.38.0 peer-depends on `apache-arrow >=15.0.0 <=18.1.0`. With
arrow 21.x, `createEmptyTable` fails:
`Failed to marshal schema from JS to Rust: Arrow error: Parser error: Unable to get root as footer`.
Pin `apache-arrow@18.1.0`.

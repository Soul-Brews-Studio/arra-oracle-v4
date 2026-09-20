"""Python side of the revision/evidence byte contract: the fail-closed bridge.

What is proven here: the adapter frames a batch, the REAL Bun worker
canonicalizes it, and Python recomputes every domain-separated digest from the
returned bytes; and that every transport/protocol failure -- overflow, timeout,
nonzero exit, malformed or extra output -- is a closed ContractError raised
BEFORE any caller write, with the worker killed rather than left running.

What is NOT proven: that Python can canonicalize anything. It cannot, by
design. The fake workers below exercise failure paths only; they are never
evidence of correct canonical bytes.
"""

import hashlib
import json
import shutil
import tempfile
import textwrap
import time
import unittest
from datetime import datetime
from pathlib import Path

from arra_migrate.revision_v1 import (
    MAX_DOCUMENT_BYTES,
    BatchItem,
    ContractError,
    WorkerConfig,
    encode_request,
    int64_text_to_value,
    naive_us_to_timestamp,
    run_batch,
    strict_binary64_loads,
    timestamp_to_naive_us,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "revision-v1"
KA = json.loads((FIXTURES / "revision-known-answer.json").read_text(encoding="utf-8"))
SERVER = Path(__file__).resolve().parents[2] / "server"


def _revision_item(item_id: str = "r") -> BatchItem:
    return BatchItem(id=item_id, op="revision", payload={"content": dict(KA["revision"]["input_content"])})


def _target_item(item_id: str = "t") -> BatchItem:
    return BatchItem(id=item_id, op="target", payload=dict(KA["target"]["input"]))


class RealBridgeTests(unittest.TestCase):
    """Python -> real Bun worker -> Python, digests recomputed here."""

    def test_revision_and_target_known_answers_through_the_real_worker(self):
        results = run_batch([_revision_item(), _target_item()])
        self.assertEqual([r.id for r in results], ["r", "t"])
        rev = results[0].value
        # Bytes and digest match the HAND-AUTHORED fixture, not something this test derived.
        self.assertEqual(rev["canonical_json"], KA["revision"]["expected"]["canonical_json"])
        self.assertEqual(rev["content_digest"], KA["revision"]["expected"]["content_digest"])
        self.assertEqual(rev["columns"], KA["revision"]["expected"]["columns"])
        # Independently recomputed here with hashlib over the returned text.
        self.assertEqual(hashlib.sha256(b"arra-revision/v1\n" + rev["canonical_json"].encode("utf-8")).hexdigest(), rev["content_digest"])
        tgt = results[1].value
        self.assertEqual(tgt, KA["target"]["expected"])
        self.assertEqual(hashlib.sha256(b"arra-target/v1\n" + tgt["key_json"].encode("utf-8")).hexdigest(), tgt["target_key"])

    def test_python_does_not_renormalize_raw_numbers_bun_does(self):
        # Input 9007199254740993 legitimately becomes 9007199254740992 under binary64 -- Bun's call, not Python's.
        content = dict(KA["revision"]["input_content"])
        content["fields"] = '{"big":9007199254740993}'
        [r] = run_batch([BatchItem(id="r", op="revision", payload={"content": content})])
        self.assertEqual(r.value["columns"]["fields"], '{"big":9007199254740992}')
        # The adapter's consistency check parsed the returned text with binary64 semantics and did not object.
        self.assertEqual(strict_binary64_loads(r.value["columns"]["fields"]), {"big": 9007199254740992.0})

    def test_replay_ops_round_trip(self):
        d = "a" * 64
        inc = {"workspace_name": "w", "source_namespace": "relic/บัญชี-primary", "source_message_id": "275", "content_digest": d}
        ex = {**inc, "message_public_id": "Msg00000000000000001_"}
        [r] = run_batch([BatchItem(id="s", op="source_replay", payload={"incoming": inc, "existing": ex})])
        self.assertEqual(r.value, {"outcome": "idempotent", "original_id": "Msg00000000000000001_"})

    def test_all_items_validate_before_any_success_and_the_caller_write_never_runs(self):
        writes: list[str] = []
        bad = BatchItem(id="bad", op="target", payload={"workspace_name": "w", "target_kind": "url", "target": {"url": "ftp://x/"}})
        with self.assertRaises(ContractError) as caught:
            results = run_batch([_target_item("good"), bad])
            writes.append("wrote")  # a caller's scratch write callback would go here
            del results
        self.assertEqual((caught.exception.code, caught.exception.item_id, caught.exception.path), ("invalid_value", "bad", "/target/url"))
        self.assertEqual(writes, [])

    def test_empty_batch_returns_empty(self):
        self.assertEqual(run_batch([]), [])

    def test_request_framing_limits_are_local_and_closed(self):
        with self.assertRaises(ContractError) as c:
            encode_request([BatchItem(id="a", op="target", payload={})] * 65)
        self.assertEqual((c.exception.code, c.exception.path), ("limit_exceeded", "/items"))
        with self.assertRaises(ContractError) as c:
            encode_request([BatchItem(id="a", op="target", payload={}), BatchItem(id="a", op="target", payload={})])
        self.assertEqual((c.exception.code, c.exception.path), ("invalid_value", "/items/1/id"))
        with self.assertRaises(ContractError) as c:
            encode_request([BatchItem(id="x" * 129, op="target", payload={})])
        self.assertEqual(c.exception.code, "limit_exceeded")


class RequestFramingRegressions(unittest.TestCase):
    """Reviewer findings (1) and (2): closed errors BEFORE spawn, never leaked Python exceptions."""

    def test_per_payload_1mib_bound_at_the_exact_boundary(self):
        base = dict(KA["revision"]["input_content"])
        base["body"] = ""
        overhead = len(json.dumps({"content": base}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        at_limit = {**base, "body": "x" * (MAX_DOCUMENT_BYTES - overhead)}
        self.assertEqual(len(json.dumps({"content": at_limit}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), MAX_DOCUMENT_BYTES)
        encode_request([BatchItem(id="r", op="revision", payload={"content": at_limit})])  # exactly 1 MiB: accepted
        over = {**base, "body": "x" * (MAX_DOCUMENT_BYTES - overhead + 1)}
        with self.assertRaises(ContractError) as c:
            encode_request([BatchItem(id="r", op="revision", payload={"content": over})])
        self.assertEqual((c.exception.code, c.exception.path), ("limit_exceeded", "/items/0/payload"))
        # The reviewer's exact shape: a url target padded past 1 MiB but far under the 16 MiB transport cap.
        with self.assertRaises(ContractError) as c:
            encode_request([BatchItem(id="u", op="target", payload={"workspace_name": "w", "target_kind": "url", "target": {"url": "https://a.test/" + "p" * MAX_DOCUMENT_BYTES}})])
        self.assertEqual((c.exception.code, c.exception.path), ("limit_exceeded", "/items/0/payload"))

    def test_non_json_request_values_are_closed_errors_with_pointers_not_leaked_exceptions(self):
        cases = [
            ({"content": {"title": "\ud800"}}, "invalid_unicode", "/items/0/payload/content/title"),
            ({"content": {"n": float("nan")}}, "invalid_value", "/items/0/payload/content/n"),
            ({"content": {"n": float("inf")}}, "invalid_value", "/items/0/payload/content/n"),
            ({"content": {"blob": b"bytes"}}, "invalid_type", "/items/0/payload/content/blob"),
            ({"content": {"when": datetime(2026, 1, 1)}}, "invalid_type", "/items/0/payload/content/when"),  # noqa: DTZ001
            ({"content": {"s": {1, 2}}}, "invalid_type", "/items/0/payload/content/s"),
            ({"content": {"nested": [{"deep": {"x": float("nan")}}]}}, "invalid_value", "/items/0/payload/content/nested/0/deep/x"),
            ({"content": {"a/b~c": {"k": float("nan")}}}, "invalid_value", "/items/0/payload/content/a~1b~0c/k"),
            ({"content": {1: "non-string key"}}, "invalid_type", "/items/0/payload/content"),
        ]
        for payload, code, path in cases:
            with self.subTest(code=code, path=path):
                with self.assertRaises(ContractError) as c:
                    encode_request([BatchItem(id="r", op="revision", payload=payload)])
                self.assertEqual((c.exception.code, c.exception.path), (code, path))

    def test_identity_validation_precedes_payload_validation_for_ALL_items(self):
        """§7 ordering parity with the worker: identities first, then payloads in order."""
        big = {"workspace_name": "w", "target_kind": "url", "target": {"url": "https://a.test/" + "p" * MAX_DOCUMENT_BYTES}}
        small = {"workspace_name": "w", "target_kind": "session", "target": {"session_name": "s1"}}
        # PIN 1: item 0 oversized, items 1 and 2 share an id -> the DUPLICATE wins, not the size.
        with self.assertRaises(ContractError) as c:
            encode_request([
                BatchItem(id="big", op="target", payload=big),
                BatchItem(id="d", op="target", payload=small),
                BatchItem(id="d", op="target", payload=small),
            ])
        self.assertEqual((c.exception.code, c.exception.path), ("invalid_value", "/items/2/id"))
        # PIN 2: a later bad OP also outranks an earlier oversized payload.
        with self.assertRaises(ContractError) as c:
            encode_request([
                BatchItem(id="big", op="target", payload=big),
                BatchItem(id="x", op="nope", payload=small),
            ])
        self.assertEqual((c.exception.code, c.exception.path), ("invalid_value", "/items/1/op"))
        # PIN 3: with every identity valid, the oversized payload is reported under ITS index, in order.
        with self.assertRaises(ContractError) as c:
            encode_request([
                BatchItem(id="ok", op="target", payload=small),
                BatchItem(id="big", op="target", payload=big),
                BatchItem(id="bad", op="target", payload={"content": {"n": float("nan")}}),
            ])
        self.assertEqual((c.exception.code, c.exception.path), ("limit_exceeded", "/items/1/payload"))

    def test_malformed_op_shape_is_a_closed_error_not_a_type_error(self):
        for bad_op in (["target"], {"op": "target"}, 7, None):
            with self.subTest(op=repr(bad_op)):
                with self.assertRaises(ContractError) as c:
                    encode_request([BatchItem(id="r", op=bad_op, payload={})])  # type: ignore[arg-type]
                self.assertEqual((c.exception.code, c.exception.path), ("invalid_type", "/items/0/op"))


class FakeWorkerTests(unittest.TestCase):
    """Transport failure paths against scratch Bun scripts. Not canonicalization evidence.

    Every fake writes a MARKER file after the misbehaviour. The assertions that
    the marker is absent prove the worker was killed, not merely that an
    exception eventually surfaced after it ran to completion.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-fake-worker-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.marker = self.root / "marker"

    def fake(self, body: str, deadline: float = 30.0) -> WorkerConfig:
        script = self.root / "fake.ts"
        script.write_text(textwrap.dedent(body).replace("MARKER", json.dumps(str(self.marker))), encoding="utf-8")
        return WorkerConfig(script=script, cwd=SERVER, deadline_seconds=deadline)

    def run_and_expect(self, config: WorkerConfig, code: str) -> ContractError:
        started = time.monotonic()
        with self.assertRaises(ContractError) as caught:
            run_batch([_target_item()], config)
        self.elapsed = time.monotonic() - started
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        return caught.exception

    # ---- overflow: the reviewer's finding, reproduced and closed ----

    def test_stderr_overflow_kills_the_worker_before_its_next_statement(self):
        cfg = self.fake("""
            import { writeFileSync } from "node:fs";
            process.stderr.write("e".repeat(131072));
            await Bun.sleep(300);
            writeFileSync(MARKER, "ran");
            process.stdout.write('{"version":"arra-contract-batch/v1","ok":true,"results":[],"error":null}\\n');
        """)
        self.run_and_expect(cfg, "limit_exceeded")
        self.assertFalse(self.marker.exists(), "worker continued past stderr overflow")

    def test_stderr_cap_plus_one_is_still_overflow_and_still_kills(self):
        cfg = self.fake("""
            import { writeFileSync } from "node:fs";
            process.stderr.write("e".repeat(65537));
            await Bun.sleep(300);
            writeFileSync(MARKER, "ran");
        """)
        self.run_and_expect(cfg, "limit_exceeded")
        self.assertFalse(self.marker.exists(), "cap+1 on stderr did not kill the worker")

    def test_stdout_overflow_kills_the_worker(self):
        cfg = self.fake("""
            import { writeFileSync } from "node:fs";
            const chunk = "o".repeat(1024 * 1024);
            for (let i = 0; i < 17; i++) process.stdout.write(chunk);
            await Bun.sleep(300);
            writeFileSync(MARKER, "ran");
        """)
        self.run_and_expect(cfg, "limit_exceeded")
        self.assertFalse(self.marker.exists(), "worker continued past stdout overflow")

    def test_stdout_cap_plus_one_kills(self):
        cfg = self.fake("""
            import { writeFileSync } from "node:fs";
            process.stdout.write("o".repeat(16 * 1024 * 1024 + 1));
            await Bun.sleep(300);
            writeFileSync(MARKER, "ran");
        """)
        self.run_and_expect(cfg, "limit_exceeded")
        self.assertFalse(self.marker.exists())

    # ---- deadline covers the whole exchange ----

    def test_deadline_kills_a_hung_worker_and_covers_the_drain(self):
        cfg = self.fake("""
            import { writeFileSync } from "node:fs";
            await Bun.sleep(60_000);
            writeFileSync(MARKER, "ran");
        """, deadline=1.0)
        self.run_and_expect(cfg, "worker_failure")
        self.assertLess(self.elapsed, 3.0, f"deadline not enforced: {self.elapsed:.2f}s")
        self.assertFalse(self.marker.exists())

    def test_deadline_covers_stdin_delivery_when_the_worker_never_reads(self):
        cfg = self.fake("""
            import { writeFileSync } from "node:fs";
            // Never touches stdin; a large request would otherwise block the writer forever.
            await Bun.sleep(60_000);
            writeFileSync(MARKER, "ran");
        """, deadline=1.0)
        # 40 items x ~300 KiB: each under the 1 MiB per-payload cap, ~12 MiB total under the transport cap,
        # and far more than a pipe buffer -- so the writer WOULD block forever without the deadline.
        big = [BatchItem(id=f"r{i}", op="revision", payload={"content": {**KA["revision"]["input_content"], "body": "x" * (300 * 1024)}}) for i in range(40)]
        started = time.monotonic()
        with self.assertRaises(ContractError) as c:
            run_batch(big, cfg)
        self.assertEqual(c.exception.code, "worker_failure")
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertFalse(self.marker.exists())

    # ---- malformed output: the reviewer's two repros, plus neighbours ----

    def test_error_code_as_list_is_a_closed_error_not_a_type_error(self):
        cfg = self.fake("""
            process.stdout.write(JSON.stringify({version:"arra-contract-batch/v1",ok:false,results:[],
              error:{item_id:null,detail:{version:"arra-error/v1",code:[],path:"",message:"x"}}}) + "\\n");
        """)
        e = self.run_and_expect(cfg, "invalid_type")
        self.assertEqual(e.path, "/error/detail/code")

    def test_key_json_with_lone_surrogate_is_a_closed_error_not_a_unicode_error(self):
        cfg = self.fake("""
            process.stdout.write(JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,
              results:[{id:"t",op:"target",value:{target_json:"{}",key_json:"\\ud800",target_key:"0".repeat(64)}}]}) + "\\n");
        """)
        e = self.run_and_expect(cfg, "invalid_unicode")
        self.assertEqual(e.path, "/results/0/value/key_json")

    def test_other_malformed_shapes_map_to_worker_failure_not_python_exceptions(self):
        cases = {
            "results_not_list": 'JSON.stringify({version:"arra-contract-batch/v1",ok:true,results:{},error:null})',
            "ok_not_boolean": 'JSON.stringify({version:"arra-contract-batch/v1",ok:"true",results:[],error:null})',
            "result_id_number": 'JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,results:[{id:5,op:"target",value:{}}]})',
            "value_is_string": 'JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,results:[{id:"t",op:"target",value:"nope"}]})',
            "digest_number": 'JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,results:[{id:"t",op:"target",value:{target_json:"{}",key_json:"{}",target_key:12}}]})',
            "two_lines": '"{}\\n{}"',
            "empty": '""',
            "not_json": '"garbage"',
            "wrong_count": 'JSON.stringify({version:"arra-contract-batch/v1",ok:true,results:[],error:null})',
            "success_with_error": 'JSON.stringify({version:"arra-contract-batch/v1",ok:true,results:[],error:{}})',
        }
        for name, expr in cases.items():
            with self.subTest(case=name):
                cfg = self.fake(f'process.stdout.write({expr} + "\\n");')
                with self.assertRaises(ContractError) as c:
                    run_batch([_target_item()], cfg)
                self.assertIn(c.exception.code, {"worker_failure", "invalid_type", "invalid_json", "invalid_value", "missing_field", "unexpected_field"}, name)

    def test_tampered_digest_is_digest_mismatch(self):
        cfg = self.fake("""
            process.stdout.write(JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,
              results:[{id:"t",op:"target",value:{target_json:'{"session_name":"s1"}',key_json:'{"identity":{"session_name":"s1"},"target_kind":"session","workspace_name":"w"}',target_key:"0".repeat(64)}}]}) + "\\n");
        """)
        e = self.run_and_expect(cfg, "target_key_mismatch")
        self.assertEqual(e.path, "/results/0/value/target_key")

    def test_deeply_nested_response_is_limit_exceeded_not_recursion_error(self):
        cfg = self.fake("""
            const deep = "[".repeat(5000) + "]".repeat(5000);
            process.stdout.write('{"version":"arra-contract-batch/v1","ok":true,"error":null,"results":[{"id":"t","op":"target","value":' + deep + '}]}\\n');
        """)
        self.run_and_expect(cfg, "limit_exceeded")

    # ---- reviewer findings (1)(3)(4) on the RESPONSE side ----

    def test_returned_document_over_1mib_is_limit_exceeded(self):
        cfg = self.fake("""
            process.stdout.write(JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,
              results:[{id:"t",op:"target",value:{target_json:"{}",key_json:'"' + "k".repeat(1024*1024) + '"',target_key:"0".repeat(64)}}]}) + "\\n");
        """)
        e = self.run_and_expect(cfg, "limit_exceeded")
        self.assertEqual(e.path, "/results/0/value/key_json")

    def test_error_path_must_be_a_valid_rfc6901_pointer(self):
        for bad in ("not/a~pointer", "no-leading-slash", "/ok/~", "/ok/~2", "/~x"):
            with self.subTest(path=bad):
                cfg = self.fake(f"""
                    process.stdout.write(JSON.stringify({{version:"arra-contract-batch/v1",ok:false,results:[],
                      error:{{item_id:null,detail:{{version:"arra-error/v1",code:"invalid_value",path:{json.dumps(bad)},message:"x"}}}}}}) + "\\n");
                """)
                e = self.run_and_expect(cfg, "invalid_value")
                self.assertEqual(e.path, "/error/detail/path")
        for good in ("", "/", "/a/b", "/a~0b/c~1d", "/0/1"):
            with self.subTest(path=good):
                cfg = self.fake(f"""
                    process.stdout.write(JSON.stringify({{version:"arra-contract-batch/v1",ok:false,results:[],
                      error:{{item_id:null,detail:{{version:"arra-error/v1",code:"invalid_value",path:{json.dumps(good)},message:"x"}}}}}}) + "\\n");
                """)
                e = self.run_and_expect(cfg, "invalid_value")
                self.assertEqual(e.path, good)   # passed through as the worker's own error

    def test_idempotent_original_id_must_be_nanoid21(self):
        cfg = self.fake("""
            process.stdout.write(JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,
              results:[{id:"t",op:"source_replay",value:{outcome:"idempotent",original_id:"not-a-nanoid"}}]}) + "\\n");
        """)
        with self.assertRaises(ContractError) as c:
            run_batch([BatchItem(id="t", op="source_replay", payload={"incoming": {"workspace_name": "w", "source_namespace": "n", "source_message_id": "1", "content_digest": "a" * 64}, "existing": None})], cfg)
        self.assertEqual((c.exception.code, c.exception.path), ("invalid_value", "/results/0/value/original_id"))

    def _fake_revision_with(self, envelope_fields: str, column_fields: str) -> WorkerConfig:
        # Correct digest over the returned canonical text, so only the type-aware consistency check can catch it.
        return self.fake(f"""
            import {{ createHash }} from "node:crypto";
            const canonical = JSON.stringify({{author_peer_name:"neo",base_revision_id:null,body:"B",body_format:"text",canonical_version:"arra-revision/v1",change_reason:null,
              fields:{envelope_fields},h_metadata:null,internal_metadata:{{k:"v"}},is_active:true,links:[],node_id:"Node0000000000000001_",observer_peer_name:null,
              schema_version:"1",session_name:null,subject_peer_name:"nat",terms:[],title:"T",valid_from:"2026-09-18T03:39:42.000Z",valid_to:null,workspace_name:"w"}});
            const digest = createHash("sha256").update("arra-revision/v1\\n","utf8").update(canonical,"utf8").digest("hex");
            process.stdout.write(JSON.stringify({{version:"arra-contract-batch/v1",ok:true,error:null,results:[{{id:"r",op:"revision",value:{{
              canonical_json:canonical,content_digest:digest,
              columns:{{fields:{json.dumps(column_fields)},term_snapshot_json:"[]",link_snapshot_json:"[]",h_metadata:null,internal_metadata:'{{"k":"v"}}'}}}}}}]}}) + "\\n");
        """)

    def test_HIGH_boolean_vs_number_disagreement_between_envelope_and_column_is_rejected(self):
        item = BatchItem(id="r", op="revision", payload={"content": {**KA["revision"]["input_content"], "workspace_name": "w"}})
        # true vs 1, false vs 0, nested, and inside arrays -- all used to pass under Python `==`.
        for env, col in [
            ("{a:true}", '{"a":1}'),
            ("{a:false}", '{"a":0}'),
            ("{a:1}", '{"a":true}'),
            ("{a:{b:[true]}}", '{"a":{"b":[1]}}'),
            ("{a:null}", '{"a":false}'),
            ("{a:\"1\"}", '{"a":1}'),
        ]:
            with self.subTest(envelope=env, column=col):
                with self.assertRaises(ContractError) as c:
                    run_batch([item], self._fake_revision_with(env, col))
                self.assertEqual((c.exception.code, c.exception.path), ("invalid_value", "/results/0/value/columns/fields"))
        # Genuine binary64 equivalences are NOT disagreements: 1 vs 1.0, -0 vs 0.
        for env, col in [("{a:1}", '{"a":1.0}'), ("{a:0}", '{"a":-0}'), ("{a:1.5e0}", '{"a":1.5}')]:
            with self.subTest(envelope=env, column=col):
                run_batch([item], self._fake_revision_with(env, col))

    def test_HIGH_same_pattern_in_target_identity_consistency(self):
        cfg = self.fake("""
            import { createHash } from "node:crypto";
            const key = JSON.stringify({identity:{n:true},target_kind:"url",workspace_name:"w"});
            const k = createHash("sha256").update("arra-target/v1\\n","utf8").update(key,"utf8").digest("hex");
            process.stdout.write(JSON.stringify({version:"arra-contract-batch/v1",ok:true,error:null,
              results:[{id:"t",op:"target",value:{target_json:'{"n":1}',key_json:key,target_key:k}}]}) + "\\n");
        """)
        with self.assertRaises(ContractError) as c:
            run_batch([BatchItem(id="t", op="target", payload={"workspace_name": "w", "target_kind": "url", "target": {"url": "https://a.test/"}})], cfg)
        self.assertEqual((c.exception.code, c.exception.path), ("invalid_value", "/results/0/value/key_json/identity"))

    def test_nonzero_exit_is_worker_failure(self):
        cfg = self.fake('process.stderr.write("boom\\n"); process.exit(3);')
        e = self.run_and_expect(cfg, "worker_failure")
        self.assertIn("exited 3", str(e))

    def test_missing_script_is_worker_failure(self):
        cfg = WorkerConfig(script=self.root / "does-not-exist.ts", cwd=SERVER)
        self.run_and_expect(cfg, "worker_failure")


class IsolationTests(unittest.TestCase):
    """Bounded source-text checks for enumerated contract/adapter import patterns.

    Recursive file selection plus floors detects a collapsed scan. These checks
    report absence of specified substrings in the selected files, not
    TypeScript/Python import resolution, aliases, arbitrary re-exports or
    runtime isolation.
    """

    PY_ROOT = Path(__file__).resolve().parents[1] / "src" / "arra_migrate"
    TS_ROOT = Path(__file__).resolve().parents[2] / "server" / "src"
    CLI = Path(__file__).resolve().parents[2] / "cli.ts"
    NEW_TS = ("jcs", "common", "errors", "evidence-v1", "revision-v1", "replay-v1", "batch-v1", "batch-worker")
    # The #25 pure-policy slice is REQUIRED by its contract to reuse the strict
    # JSON/Unicode/time helpers, so it is the one file exempt from the scan
    # below. Exempting the exact file, never the whole `auth/` directory: a
    # future auth module must not inherit this exemption silently.
    # The #25 integration landed, so the isolated-policy no-import gate is
    # deliberately RETIRED: auth/ modules now legitimately reuse the shared
    # strict JSON/Unicode/time helpers, and the composition graph imports the
    # policy module on purpose. What replaces it is a bounded EXACT dependency
    # check matching the reviewed composition, below.
    AUTH_DIR = TS_ROOT / "auth"
    # Exactly the modules allowed to reuse the contract helpers. This is an
    # allow-LIST of specific files, never a blanket `auth/` exclusion: a new
    # module must be added here deliberately, with review.
    HELPER_REUSE_ALLOWED = (
        TS_ROOT / "auth" / "policy.ts",
        TS_ROOT / "auth" / "loader.ts",
        TS_ROOT / "app.ts",
        # The #26 publication kernel reuses the governed codecs by contract:
        # it must not carry a second canonicalizer. EXACT files only -- never
        # a blanket publication/ exclusion, so a new module there has to be
        # added here deliberately and reviewed.
        TS_ROOT / "publication" / "errors.ts",
        TS_ROOT / "publication" / "rows.ts",
        TS_ROOT / "publication" / "storage.ts",
        TS_ROOT / "publication" / "service.ts",
        # The #47 taxonomy kernel reuses the SAME governed helpers for the same
        # reason: it must not carry a second parser or a second canonicalizer.
        # Listed as an exact file, deliberately, so the next module added under
        # publication/ still has to be reviewed rather than inheriting this.
        TS_ROOT / "publication" / "taxonomy.ts",
    )

    #: The publication kernel is internal: no active source may import it.
    PUBLICATION_FILES = (
        TS_ROOT / "publication" / "errors.ts",
        TS_ROOT / "publication" / "rows.ts",
        TS_ROOT / "publication" / "storage.ts",
        TS_ROOT / "publication" / "service.ts",
        TS_ROOT / "publication" / "taxonomy.ts",
    )
    PUBLICATION_IMPORT_PATTERNS = (
        "publication/taxonomy",
        "publication/service",
        "publication/storage",
        "publication/rows",
        "publication/errors",
        "./publication",
        "../publication",
    )
    #: `writer_gate` is a fixture/operator tool, not an active migrator import.
    WRITER_GATE_PATTERNS = ("writer_gate", "from .writer_gate", "arra_migrate.writer_gate")
    # Adapters must not reach raw data/model/audit modules directly; they go
    # through the admitted operation service.
    ADAPTER_FILES = (
        TS_ROOT / "app.ts",
        TS_ROOT / "mcp" / "index.ts",
        # The HTTP entrypoint too: it imported ./db directly, contrary to the
        # frozen section 3, and now delegates trusted index work to composition.
        TS_ROOT / "index.ts",
    )
    RAW_DEPENDENCY_PATTERNS = ("./db", "../db", "./embed", "../embed", "./storage", "../storage", "./calls", "../mcp/calls")

    def test_no_active_python_path_imports_the_adapter(self):
        scanned = [p for p in self.PY_ROOT.rglob("*.py") if p.name != "revision_v1.py"]
        self.assertGreaterEqual(len(scanned), 35, f"scan collapsed: {len(scanned)} modules")
        for path in scanned:
            with self.subTest(module=str(path.relative_to(self.PY_ROOT))):
                self.assertNotIn("revision_v1", path.read_text(encoding="utf-8"))

    def test_only_reviewed_modules_reuse_the_contract_helpers(self):
        contracts = self.TS_ROOT / "contracts"
        allowed = set(self.HELPER_REUSE_ALLOWED)
        scanned = [
            p
            for p in self.TS_ROOT.rglob("*.ts")
            if contracts not in p.parents and p not in allowed
        ] + [self.CLI]
        self.assertGreaterEqual(len(scanned), 8, f"scan collapsed: {len(scanned)} files")
        for path in self.HELPER_REUSE_ALLOWED:
            self.assertNotIn(path, scanned)
        for path in scanned:
            text = path.read_text(encoding="utf-8")
            for module in self.NEW_TS:
                with self.subTest(file=path.name, module=module):
                    self.assertNotIn(f"contracts/{module}", text)
                    self.assertNotIn(f"./{module}", text)

    def test_adapters_do_not_import_raw_data_model_or_audit_modules(self):
        """Adapters receive the admitted service, never a raw store handle.

        Bounded source-text check over the reviewed adapter files. It reports
        absence of enumerated import substrings; it does not resolve imports or
        prove anything about runtime reachability.
        """
        for path in self.ADAPTER_FILES:
            self.assertTrue(path.exists(), f"adapter missing: {path}")
            text = path.read_text(encoding="utf-8")
            for pattern in self.RAW_DEPENDENCY_PATTERNS:
                with self.subTest(file=path.name, pattern=pattern):
                    self.assertNotIn(f'from "{pattern}"', text)

    def test_no_active_server_source_imports_the_publication_kernel(self):
        """Nothing outside the four publication files may import them.

        Bounded source-text check over server sources plus the CLI: it reports
        absence of enumerated substrings. It is NOT module resolution and does
        not prove a dynamic `import(expr)` is impossible.
        """
        publication = set(self.PUBLICATION_FILES)
        scanned = [p for p in self.TS_ROOT.rglob("*.ts") if p not in publication] + [self.CLI]
        self.assertGreaterEqual(len(scanned), 8, f"scan collapsed: {len(scanned)} files")
        for path in self.PUBLICATION_FILES:
            self.assertNotIn(path, scanned)
        for path in scanned:
            text = path.read_text(encoding="utf-8")
            for pattern in self.PUBLICATION_IMPORT_PATTERNS:
                with self.subTest(file=path.name, pattern=pattern):
                    self.assertNotIn(pattern, text)

    def test_no_active_python_source_imports_the_writer_gate(self):
        """`writer_gate` is an operator/fixture tool, not a migrator import."""
        scanned = [p for p in self.PY_ROOT.rglob("*.py") if p.name != "writer_gate.py"]
        self.assertGreaterEqual(len(scanned), 35, f"scan collapsed: {len(scanned)} modules")
        for path in scanned:
            text = path.read_text(encoding="utf-8")
            for pattern in self.WRITER_GATE_PATTERNS:
                with self.subTest(module=path.name, pattern=pattern):
                    self.assertNotIn(pattern, text)

    def test_the_publication_import_scan_fires_on_representative_text(self):
        """Sensitivity, on INDEPENDENT hand-written source.

        Written by hand rather than generated from the pattern tuple: a test
        that formats its own patterns into a file and finds them again is
        circular, and a typo would still pass. Fixtures live in a
        TemporaryDirectory; nothing is written into product source.
        """
        # One sample per enumerated pattern, so each is genuinely exercised.
        flagged = (
            'import { openPublicationWriter } from "src/publication/service";\n',
            'import { quote } from "src/publication/storage";\n',
            'import { encodeRevisionRow } from "src/publication/rows";\n',
            'import { PublicationError } from "src/publication/errors";\n',
            'import { failTaxonomy } from "src/publication/taxonomy";\n',
            'const a = await import("./publication");\n',
            'const b = await import("../publication");\n',
        )
        benign = (
            'import { createApp } from "./app";\n',
            'import { admit } from "./auth/policy";\n',
            "// publication is documented in app/docs/contracts\n",
        )
        hits = lambda text: [p for p in self.PUBLICATION_IMPORT_PATTERNS if p in text]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertNotIn(str(self.TS_ROOT), str(root))
            matched = set()
            for index, source in enumerate(flagged):
                probe = root / f"flagged_{index}.ts"
                probe.write_text(source, encoding="utf-8")
                with self.subTest(kind="flagged", source=source.strip()):
                    found = hits(probe.read_text(encoding="utf-8"))
                    self.assertNotEqual([], found)
                    matched.update(found)
            # EVERY pattern must be exercised by some sample. Asserting only
            # "something matched" let a typo'd pattern hide behind a broader
            # sibling -- measured: corrupting one entry still passed.
            self.assertEqual(
                set(self.PUBLICATION_IMPORT_PATTERNS),
                matched,
                "some enumerated pattern is never exercised by a flagged sample",
            )
            for index, source in enumerate(benign):
                probe = root / f"benign_{index}.ts"
                probe.write_text(source, encoding="utf-8")
                with self.subTest(kind="benign", source=source.strip()):
                    self.assertEqual([], hits(probe.read_text(encoding="utf-8")))

    def test_the_raw_mcp_dispatcher_is_no_longer_a_runtime_export(self):
        """`handleMcp(body, bank)` operated with no admission; it must be gone."""
        text = (self.TS_ROOT / "mcp" / "index.ts").read_text(encoding="utf-8")
        self.assertNotIn("export async function handleMcp", text)
        self.assertNotIn("export function handleMcp", text)

    def test_the_raw_dependency_scan_fires_on_representative_text(self):
        """Sensitivity of the adapter scan, on independent hand-written text.

        The probe source below is written by hand rather than generated from
        RAW_DEPENDENCY_PATTERNS: a test that formats the pattern list into a
        file and then finds it again is circular, and a typo in the list would
        still pass. Fixtures live in a TemporaryDirectory; tests never write
        into the product source tree.
        """
        flagged = (
            'import * as store from "./db";\n',
            'import { health } from "./embed";\n',
            'import { storageInfo } from "./storage";\n',
            'import * as calls from "../mcp/calls";\n',
        )
        benign = (
            'import { createApp } from "./app";\n',
            'import type { OperationService } from "./auth/service";\n',
            "// the store is reached only through the admitted service\n",
        )
        hits = lambda text: [p for p in self.RAW_DEPENDENCY_PATTERNS if f'from "{p}"' in text]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertNotIn(str(self.TS_ROOT), str(root))
            for index, source in enumerate(flagged):
                probe = root / f"flagged_{index}.ts"
                probe.write_text(source, encoding="utf-8")
                with self.subTest(kind="flagged", source=source.strip()):
                    self.assertNotEqual([], hits(probe.read_text(encoding="utf-8")))
            for index, source in enumerate(benign):
                probe = root / f"benign_{index}.ts"
                probe.write_text(source, encoding="utf-8")
                with self.subTest(kind="benign", source=source.strip()):
                    self.assertEqual([], hits(probe.read_text(encoding="utf-8")))

    def test_the_adapter_itself_imports_no_lancedb_or_storage(self):
        text = (self.PY_ROOT / "revision_v1.py").read_text(encoding="utf-8")
        for forbidden in ("import lancedb", "from lancedb", "from .storage", "from .models", "from . import models", "from .embeddings"):
            self.assertNotIn(forbidden, text)


class FixtureAdapterTests(unittest.TestCase):
    def test_timestamp_adapters_are_explicit_and_refuse_to_round(self):
        naive = timestamp_to_naive_us("2026-09-18T03:39:42.120Z")
        # Naive on purpose: the physical column is timestamp[us] WITHOUT timezone.
        self.assertEqual(naive, datetime(2026, 9, 18, 3, 39, 42, 120000))  # noqa: DTZ001
        self.assertEqual(naive_us_to_timestamp(naive), "2026-09-18T03:39:42.120Z")
        with self.assertRaises(ValueError):
            naive_us_to_timestamp(datetime(2026, 9, 18, 3, 39, 42, 120001))  # noqa: DTZ001 - sub-millisecond: refuse, do not round
        self.assertIsNone(timestamp_to_naive_us(None))
        self.assertIsNone(naive_us_to_timestamp(None))

    def test_int64_text_only_at_the_row_boundary(self):
        self.assertEqual(int64_text_to_value("9007199254740993"), 9007199254740993)
        with self.assertRaises(ValueError):
            int64_text_to_value("01")

    def test_strict_binary64_loads_rejects_duplicates_and_nonfinite(self):
        with self.assertRaises(ContractError):
            strict_binary64_loads('{"a":1,"a":2}')
        with self.assertRaises(ContractError):
            strict_binary64_loads("[NaN]")
        self.assertEqual(strict_binary64_loads("[9007199254740993]"), [9007199254740992.0])


if __name__ == "__main__":
    unittest.main()

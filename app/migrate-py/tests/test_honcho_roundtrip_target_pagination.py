"""`target.HttpHonchoTarget`'s pagination loop, split out of
`test_honcho_roundtrip.py` to stay under this repo's 500-line-per-file limit.
Issue #8 repro G / analysis-8 test #7, 2026-09-26 fix-round finding.

Before this fix round, `HttpHonchoTarget` read only `page["items"]` from the
FIRST page of any `.../list` or `GET .../peers` response -- a 120-item
collection with the server's default page size of 50 came back truncated to
50 (measured). `target._paginate_all` fixes this; these tests run against a
REAL loopback HTTP server (`_PaginatedListStubHandler`), not a
`unittest.mock` stand-in for `requests` -- the query-string round trip is
exactly what a mocked `requests.post` would let slide unnoticed. See
`target.HttpHonchoTarget`'s own module docstring for where the query
contract (`page`/`size` params, `items`/`total`/`page`/`size`/`pages`
response fields, `fastapi-pagination==0.15.12`) was confirmed."""

from __future__ import annotations

import http.server
import json
import threading
import unittest
import urllib.parse

from arra_migrate.honcho_roundtrip.target import HttpHonchoTarget


class _PaginatedListStubHandler(http.server.BaseHTTPRequestHandler):
    """A minimal loopback stand-in for stock Honcho's `Page[...]` response
    shape (`fastapi_pagination.Page`/`Params` at the pinned commit's own
    `fastapi-pagination==0.15.12`) -- NOT a mock of `HttpHonchoTarget`
    itself: a real socket, a real HTTP request/response, so this proves the
    client's query-string handling end to end, the same boundary a live
    Honcho container would cross. `TOTAL`/`SIZE` are set per test via a
    handler subclass (`functools.partial` cannot be used here -- `HTTPServer`
    instantiates the handler class itself per request)."""

    TOTAL = 120
    SIZE = 100  # must match target._PAGE_SIZE for a realistic single-run test

    def do_POST(self) -> None:  # noqa: N802 -- BaseHTTPRequestHandler's own naming
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self._respond_page()

    def do_GET(self) -> None:  # noqa: N802
        self._respond_page()

    def _respond_page(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        page_num = int(query.get("page", ["1"])[0])
        size = int(query.get("size", [str(self.SIZE)])[0])
        start = (page_num - 1) * size
        items = [{"id": f"item-{i:04d}"} for i in range(start, min(start + size, self.TOTAL))]
        pages = -(-self.TOTAL // size) if size else 0
        body = json.dumps({"items": items, "total": self.TOTAL, "page": page_num, "size": size, "pages": pages}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 -- stdlib signature
        pass  # silence per-request logging -- the test asserts on the result, not the transcript


class HttpTargetPaginationTests(unittest.TestCase):
    """Issue #8 repro G / analysis-8 test #7 (2026-09-26 fix-round finding):
    before this fix round, `HttpHonchoTarget` read only `page["items"]` from
    the FIRST page of any `.../list` or `GET .../peers` response -- a
    120-item collection with the server's default page size of 50 came back
    truncated to 50. These tests run against a REAL loopback HTTP server
    (`_PaginatedListStubHandler`), not a `unittest.mock` stand-in for
    `requests` -- the query-string round trip is exactly what a mocked
    `requests.post` would let slide unnoticed."""

    def setUp(self) -> None:
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _PaginatedListStubHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        # `addCleanup` runs LIFO -- added in this order so the ACTUAL teardown
        # sequence is shutdown() first (signals `serve_forever` to stop),
        # THEN join (returns almost immediately once the loop has actually
        # exited), THEN server_close(). 2026-09-26 fix-round-two finding: the
        # previous order (close, join, shutdown) called shutdown() only AFTER
        # the 5s join timeout had already elapsed, since `serve_forever` never
        # got the stop signal until then -- every test in this class paid the
        # full 5s (5 tests, ~25s total, versus ~0.7s for the other 79).
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join, timeout=5)
        self.addCleanup(self.server.shutdown)
        self.target = HttpHonchoTarget(f"http://127.0.0.1:{self.port}")

    def test_list_messages_follows_every_page(self) -> None:
        items = self.target.list_messages("ws-01", "sess-01")
        self.assertEqual(len(items), 120, items)

    def test_list_sessions_follows_every_page(self) -> None:
        items = self.target.list_sessions("ws-01")
        self.assertEqual(len(items), 120, items)

    def test_list_peers_follows_every_page(self) -> None:
        items = self.target.list_peers("ws-01")
        self.assertEqual(len(items), 120, items)

    def test_get_session_peers_follows_every_page(self) -> None:
        items = self.target.get_session_peers("ws-01", "sess-01")
        self.assertEqual(len(items), 120, items)

    def test_a_single_short_page_is_not_looped_forever(self) -> None:
        """The `Page.pages` field says there is exactly one page -- the loop
        must stop there, not keep incrementing `page` past what the server
        has (which this stub would otherwise happily keep answering with
        empty `items` lists forever)."""

        _PaginatedListStubHandler.TOTAL = 7
        self.addCleanup(setattr, _PaginatedListStubHandler, "TOTAL", 120)

        items = self.target.list_messages("ws-01", "sess-01")

        self.assertEqual(len(items), 7, items)


if __name__ == "__main__":
    unittest.main()

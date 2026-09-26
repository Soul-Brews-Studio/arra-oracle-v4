"""Two implementations of the same ``HonchoTarget`` shape. Issue #8.

``HttpHonchoTarget`` speaks the REAL routes and schema field names of stock
Honcho v3.2.0 (``pin.HONCHO_V3_2_0``), read directly from
``src/routers/{workspaces,peers,sessions,messages}.py`` and
``src/schemas/api.py`` at that git ref -- every path, verb, and field name
below is transcribed from that source, not guessed. It is the "live leg": it
does nothing until pointed at a real, running instance.

2026-09-26 fix-round finding, issue #8 repro G: every ``.../list`` and ``GET
.../peers`` route returns a ``fastapi_pagination`` ``Page``, and this client
used to read only the first page's ``items`` -- a workspace with more
members/messages than one page came back truncated (measured: a 120-item
page of size 50 came back as 50). Fixed by ``_paginate_all`` below, which
loops ``page=1,2,...`` at ``size=_PAGE_SIZE`` until ``Page.pages`` (or, if
that key is ever absent, a short page) says there is no more -- the query
contract (``page``/``size`` params, ``items``/``total``/``page``/``size``/
``pages`` response fields, default ``size=50`` capped at 100) is
``fastapi_pagination.Params``/``Page``'s OWN default shape at the version
this repo pins (``fastapi-pagination==0.15.12``, per the pinned commit's own
``uv.lock``), confirmed by reading ``src/routers/messages.py`` at
``pin.HONCHO_V3_2_0.commit_sha`` (``get_messages`` calls bare
``apaginate(db, messages_query)`` with no explicit ``Params`` override, so
the app-wide default from ``add_pagination`` applies) -- not guessed, and not
yet exercised against a REAL Honcho process (only a loopback stub server; see
``test_honcho_roundtrip.py``'s ``HttpTargetPaginationTests``), which is why
the round-trip test module's live-leg skip message still applies to this
class as a whole.

``FakeHonchoTarget`` is NOT a mock of convenience -- it encodes the specific,
verified behaviours of that same schema that make the round trip lossy, ALL
confirmed 2026-09-26 by reading ``src/schemas/api.py`` and
``src/schemas/configuration.py`` at the pinned commit:

  * ``WorkspaceCreate``/``PeerCreate``/``SessionCreate`` have no
    ``internal_metadata`` field at all (only ``metadata``/``h_metadata``
    round-trips), and none of the three accepts a client-settable
    ``created_at`` either -- Honcho stamps its own row-creation time.
  * Every one of the three narrows its id to
    ``Field(alias="id", min_length=1, max_length=512, pattern=RESOURCE_NAME_PATTERN)``,
    ``RESOURCE_NAME_PATTERN = r"^[a-zA-Z0-9_-]+$"``. Honcho's resource
    identity for workspaces/peers/sessions IS that `name` (serialized as
    ``id`` over the API) -- there is no second, independent opaque id
    alongside it the way v4 carries ``id`` + ``name`` as separate columns.
  * ``WorkspaceConfiguration``/``SessionConfiguration`` allow arbitrary extra
    top-level keys (``model_config = ConfigDict(extra="allow")``), but their
    four RESERVED sub-schema names (``reasoning``/``peer_card``/``summary``/
    ``dream``) are typed nested models that silently drop any sub-key they do
    not declare -- see ``apply_workspace_configuration_shape``.
  * ``PeerSpec.configuration`` is a plain ``dict[str, Any] | None`` with NO
    typed sub-schema at all -- unlike workspace/session configuration, an
    arbitrary peer configuration value round-trips completely.
  * ``SessionPeerConfig`` (the body of `POST .../sessions/{id}/peers`) has
    exactly two fields, ``observe_me``/``observe_others`` -- no
    ``joined_at``/``left_at``/``configuration``/``internal_metadata``.
  * ``MessageCreate`` computes ``token_count`` server-side
    (``validate_and_set_token_count``, via ``tiktoken``) and has no
    client-settable ``token_count`` field; ``Message`` exposes only
    ``public_id`` (aliased ``id``) -- v4's internal id AND public_id both
    have no Honcho-side twin. ``content`` is capped at
    ``settings.MAX_MESSAGE_SIZE`` (25,000 chars) and a batch at
    ``MessageBatchCreate.messages`` (100 messages).
  * Every metadata dict (``_SanitizedMetadata``) is capped at 100 top-level
    keys and a nesting depth of 5, checked by walking only ``dict`` values
    (a list of dicts is NOT walked) -- ``limits.check_metadata_limits`` is a
    direct port of that algorithm, and this class re-enforces it independently
    rather than trusting the exporter's own pre-check.
  * v4's four +v4 nullable ``messages`` columns (``role``, ``in_reply_to``,
    ``read``, ``read_at``) have no Honcho schema field at all. `bundle.py`'s
    export step makes an explicit, visible choice to fold them into the
    ``metadata`` dict under a namespaced key rather than silently dropping
    them -- this class proves that choice actually survives a round trip
    (arbitrary ``metadata`` keys DO pass through unchanged).

Every mutating method here also forces the payload through a real
``json.dumps``/``json.loads`` round trip before touching anything (see
``_wire_roundtrip``) -- the SAME boundary a real HTTP call crosses. A raw
``datetime`` reaching this class raises the identical ``TypeError`` the real
``requests`` json encoder raises (issue #8 repro A), so a caller that forgot
``wire.to_wire_timestamp`` fails here, in-process, not only against a real
container.

``FakeHonchoTarget``'s token-count formula is a labelled stand-in
(``len(content.split())``), NOT ``tiktoken``'s ``o200k_base`` encoding --
this harness does not depend on ``tiktoken`` and does not claim to reproduce
the real count, only that a value the client sent is discarded and a
value the client did NOT send comes back in its place.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, runtime_checkable

import requests

from . import limits, names
from .configuration_shape import apply_workspace_configuration_shape


@runtime_checkable
class HonchoTarget(Protocol):
    """The subset of the Honcho API this round trip exercises."""

    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]: ...

    def get_workspace(self, workspace_id: str) -> dict[str, Any]: ...

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]: ...

    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]: ...

    def list_sessions(self, workspace_id: str) -> list[dict[str, Any]]: ...

    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]: ...

    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]: ...

    def list_peers(self, workspace_id: str) -> list[dict[str, Any]]: ...

    def get_session_peers(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]: ...

    def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]: ...


# fastapi_pagination.Params' own default cap (`size: int = Query(50, ge=1,
# le=100)` at 0.15.12) -- requesting the max page size minimises round trips
# without exceeding what the server will accept.
_PAGE_SIZE = 100


class HttpHonchoTarget:
    """Real HTTP client for a running Honcho instance. Untested against a
    live server in this session -- see the round-trip test module for why.
    """

    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        self._base = base_url.rstrip("/") + "/v3"  # src/main.py: every router mounted under /v3
        self._timeout = timeout_s

    def _post(self, path: str, body: Any, *, params: dict[str, Any] | None = None) -> Any:
        resp = requests.post(f"{self._base}{path}", json=body, params=params, timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    def _get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        resp = requests.get(f"{self._base}{path}", params=params, timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _paginate_all(fetch_page: Any) -> list[dict[str, Any]]:
        """*fetch_page(page_num)* returns one raw ``Page[...]`` dict (1-indexed,
        ``_PAGE_SIZE`` per page) -- collect every item across every page. See
        this class's own docstring (issue #8 repro G) for the query contract
        this assumes and where it was confirmed, not guessed."""

        items: list[dict[str, Any]] = []
        page_num = 1
        while True:
            page = fetch_page(page_num)
            page_items = page["items"]
            items.extend(page_items)
            if not page_items:
                break
            total_pages = page.get("pages")
            if total_pages is not None:
                if page_num >= total_pages:
                    break
            elif len(page_items) < _PAGE_SIZE:
                # Defensive fallback only -- a `Page` response missing `pages`
                # would be a change to fastapi_pagination's own default shape
                # this class has not observed; a short page is still reliable
                # proof there is nothing left to fetch.
                break
            page_num += 1
        return items

    # routers/workspaces.py: POST /workspaces, body=WorkspaceCreate{id,metadata,configuration}
    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return self._post("/workspaces", {"id": workspace_id, "metadata": metadata, "configuration": configuration})

    # Same route: `get_or_create_workspace` returns the EXISTING row, untouched,
    # when `workspace_id` already exists (crud.get_or_create_workspace, checked
    # against a cache/DB hit before any write) -- there is no separate
    # single-resource GET for a workspace, so re-calling create IS the read.
    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        return self._post("/workspaces", {"id": workspace_id, "metadata": {}, "configuration": {}})

    # routers/peers.py: prefix /workspaces/{workspace_id}/peers, POST "" = PeerCreate{id,metadata,configuration}
    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/workspaces/{workspace_id}/peers", {"id": peer_id, "metadata": metadata, "configuration": configuration})

    # routers/sessions.py: prefix /workspaces/{workspace_id}/sessions, POST "" = SessionCreate{id,metadata,configuration}
    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/workspaces/{workspace_id}/sessions", {"id": session_id, "metadata": metadata, "configuration": configuration})

    # POST .../sessions/list -> Page[Session]. Every page (see _paginate_all
    # and the class docstring, issue #8 repro G).
    def list_sessions(self, workspace_id: str) -> list[dict[str, Any]]:
        return self._paginate_all(
            lambda p: self._post(f"/workspaces/{workspace_id}/sessions/list", None, params={"page": p, "size": _PAGE_SIZE})
        )

    # POST /workspaces/{workspace_id}/sessions/{session_id}/peers, body=dict[peer_id, SessionPeerConfig]
    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]:
        return self._post(f"/workspaces/{workspace_id}/sessions/{session_id}/peers", peers)

    # POST .../messages, body=MessageBatchCreate{messages:[MessageCreate...]}
    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return self._post(f"/workspaces/{workspace_id}/sessions/{session_id}/messages", {"messages": messages})

    # POST .../peers/list -> Page[Peer]. Every page.
    def list_peers(self, workspace_id: str) -> list[dict[str, Any]]:
        return self._paginate_all(
            lambda p: self._post(f"/workspaces/{workspace_id}/peers/list", None, params={"page": p, "size": _PAGE_SIZE})
        )

    # GET .../sessions/{session_id}/peers -> Page[Peer]. Every page.
    def get_session_peers(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        return self._paginate_all(
            lambda p: self._get(f"/workspaces/{workspace_id}/sessions/{session_id}/peers", params={"page": p, "size": _PAGE_SIZE})
        )

    # POST .../messages/list -> Page[Message]. Every page.
    def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        return self._paginate_all(
            lambda p: self._post(f"/workspaces/{workspace_id}/sessions/{session_id}/messages/list", None, params={"page": p, "size": _PAGE_SIZE})
        )


def _wire_roundtrip(payload: Any) -> Any:
    """Force the exact JSON marshal/unmarshal boundary a real HTTP call
    crosses, in-process. A non-serializable value (a bare ``datetime``, most
    importantly -- issue #8 repro A) raises here exactly as it would inside
    ``requests``' ``json=`` encoder, so the Fake catches a caller who forgot
    to wire-encode a timestamp, without needing a socket."""

    return json.loads(json.dumps(payload))


def _check_resource_name(name: str, *, where: str) -> None:
    if not name or len(name) > names.RESOURCE_NAME_MAX_LENGTH or not names.RESOURCE_NAME_PATTERN.fullmatch(name):
        raise ValueError(
            f"{where}: {name!r} does not satisfy Honcho's RESOURCE_NAME_PATTERN "
            f"{names.RESOURCE_NAME_PATTERN.pattern!r} within {names.RESOURCE_NAME_MAX_LENGTH} chars"
        )


@dataclass
class _FakeMessage:
    public_id: str
    content: str
    peer_name: str
    session_name: str
    workspace_name: str
    metadata: dict[str, Any]
    created_at: Any
    token_count: int


class FakeHonchoTarget:
    """In-process stand-in for the verified v3.2.0 schema behaviour above.

    Executed in this session (no network, no container). Exists so the
    export/import/export/diff LOGIC in ``bundle.py`` has a real, running test
    even though the live leg (against an actual Honcho process) is
    unexecuted here -- see the round-trip test module's docstring.
    """

    def __init__(self) -> None:
        self._workspaces: dict[str, dict[str, Any]] = {}
        self._peers: dict[tuple[str, str], dict[str, Any]] = {}
        self._sessions: dict[tuple[str, str], dict[str, Any]] = {}
        self._session_peers: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
        self._messages: dict[tuple[str, str], list[_FakeMessage]] = {}
        self._next_public_id = 1

    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        _check_resource_name(workspace_id, where="workspaces.id")
        metadata, configuration = _wire_roundtrip(metadata), _wire_roundtrip(configuration)
        limits.check_metadata_limits(metadata, where=f"workspaces[{workspace_id}].metadata")
        limits.check_metadata_limits(configuration, where=f"workspaces[{workspace_id}].configuration")
        existing = self._workspaces.get(workspace_id)
        if existing is not None:
            # get_or_create semantics: an existing row is returned UNCHANGED.
            return dict(existing)
        row = {
            "id": workspace_id,
            "metadata": dict(metadata),
            "configuration": apply_workspace_configuration_shape(configuration),
            "created_at": _now(),
        }
        self._workspaces[workspace_id] = row
        return dict(row)

    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        row = self._workspaces.get(workspace_id)
        if row is None:
            raise ValueError(f"workspace {workspace_id!r} does not exist")
        return dict(row)

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        _check_resource_name(peer_id, where="peers.id")
        metadata, configuration = _wire_roundtrip(metadata), _wire_roundtrip(configuration)
        limits.check_metadata_limits(metadata, where=f"peers[{peer_id}].metadata")
        # No internal_metadata parameter exists on this call at all -- there is
        # nowhere for a caller to even try passing it, matching PeerCreate.
        # configuration has NO typed sub-schema (unlike workspace/session) --
        # an arbitrary dict round-trips as-is.
        row = {"id": peer_id, "workspace_id": workspace_id, "metadata": dict(metadata), "configuration": dict(configuration), "created_at": _now()}
        self._peers[(workspace_id, peer_id)] = row
        return dict(row)

    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        _check_resource_name(session_id, where="sessions.id")
        metadata, configuration = _wire_roundtrip(metadata), _wire_roundtrip(configuration)
        limits.check_metadata_limits(metadata, where=f"sessions[{session_id}].metadata")
        limits.check_metadata_limits(configuration, where=f"sessions[{session_id}].configuration")
        existing = self._sessions.get((workspace_id, session_id))
        if existing is not None:
            return dict(existing)
        row = {
            "id": session_id, "workspace_id": workspace_id, "is_active": True,
            "metadata": dict(metadata), "configuration": apply_workspace_configuration_shape(configuration),
            "created_at": _now(),
        }
        self._sessions[(workspace_id, session_id)] = row
        self._session_peers.setdefault((workspace_id, session_id), {})
        return dict(row)

    def list_sessions(self, workspace_id: str) -> list[dict[str, Any]]:
        return [dict(s) for (ws, _sid), s in self._sessions.items() if ws == workspace_id]

    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]:
        peers = _wire_roundtrip(peers)
        # SessionPeerConfig ONLY has observe_me/observe_others -- reject
        # anything else the same way a real Pydantic model would (extra keys
        # in a strict schema are the analogue; here we just refuse to store
        # them, so a caller that tries to smuggle joined_at through finds out
        # in the fake, not only in a live 422).
        allowed = {"observe_me", "observe_others"}
        bucket = self._session_peers.setdefault((workspace_id, session_id), {})
        for peer_id, cfg in peers.items():
            _check_resource_name(peer_id, where="session_peers peer id")
            unknown = set(cfg) - allowed
            if unknown:
                raise ValueError(f"SessionPeerConfig has no field(s) {unknown} -- v3.2.0 schema only allows {allowed}")
            bucket[peer_id] = dict(cfg)
        return {"id": session_id, "workspace_id": workspace_id}

    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        messages = _wire_roundtrip(messages)
        if not (1 <= len(messages) <= limits.MESSAGE_BATCH_MAX):
            raise ValueError(f"MessageBatchCreate.messages: {len(messages)} messages, Honcho v3.2.0 accepts 1..{limits.MESSAGE_BATCH_MAX} per call")
        out = []
        bucket = self._messages.setdefault((workspace_id, session_id), [])
        for m in messages:
            if "token_count" in m:
                raise ValueError("MessageCreate has no client-settable token_count field in v3.2.0")
            if "id" in m or "public_id" in m:
                raise ValueError("MessageCreate has no client-settable id/public_id field in v3.2.0 -- only content/peer_id/metadata/configuration/created_at")
            limits.check_content_limit(m["content"], where=f"messages[{session_id}].content")
            limits.check_metadata_limits(m.get("metadata") or {}, where=f"messages[{session_id}].metadata")
            public_id = f"msg-{self._next_public_id:04d}"
            self._next_public_id += 1
            fake = _FakeMessage(
                public_id=public_id,
                content=m["content"],
                peer_name=m["peer_id"],
                session_name=session_id,
                workspace_name=workspace_id,
                metadata=dict(m.get("metadata") or {}),
                created_at=m.get("created_at") or _now(),
                token_count=len(m["content"].split()),  # stand-in only -- see module docstring
            )
            bucket.append(fake)
            out.append(self._serialize_message(fake))
        return out

    @staticmethod
    def _serialize_message(m: _FakeMessage) -> dict[str, Any]:
        return {
            "id": m.public_id,
            "content": m.content,
            "peer_id": m.peer_name,
            "session_id": m.session_name,
            "workspace_id": m.workspace_name,
            "metadata": dict(m.metadata),
            "created_at": m.created_at,
            "token_count": m.token_count,
        }

    def list_peers(self, workspace_id: str) -> list[dict[str, Any]]:
        return [dict(p) for (ws, _pid), p in self._peers.items() if ws == workspace_id]

    def get_session_peers(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        bucket = self._session_peers.get((workspace_id, session_id), {})
        return [dict(self._peers[(workspace_id, pid)]) for pid in bucket if (workspace_id, pid) in self._peers]

    def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        return [self._serialize_message(m) for m in self._messages.get((workspace_id, session_id), [])]


def _now() -> str:
    """A stand-in for Honcho's own server-assigned row timestamp -- ISO 8601,
    same shape `wire.from_wire_timestamp` parses. Not equal to any v4 input
    value by construction (see bundle.LOSSY_FIELDS: workspaces/peers/sessions
    .created_at)."""

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

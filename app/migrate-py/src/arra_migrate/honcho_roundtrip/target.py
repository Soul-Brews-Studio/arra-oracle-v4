"""Two implementations of the same ``HonchoTarget`` shape. Issue #8.

``HttpHonchoTarget`` speaks the REAL routes and schema field names of stock
Honcho v3.2.0 (``pin.HONCHO_V3_2_0``), read directly from
``src/routers/{workspaces,peers,sessions,messages}.py`` and
``src/schemas/api.py`` at that git ref on 2026-09-21 -- every path, verb, and
field name below is transcribed from that source, not guessed. It is the
"live leg": it does nothing until pointed at a real, running instance.

``FakeHonchoTarget`` is NOT a mock of convenience -- it encodes the specific,
verified behaviours of that same schema that make the round trip lossy:

  * ``WorkspaceCreate``/``PeerCreate``/``SessionCreate`` have no
    ``internal_metadata`` field at all (only ``metadata``/``h_metadata``
    round-trips). Confirmed by reading every ``*Base``/``*Create``/response
    class in ``schemas/api.py`` -- none declares it.
  * Honcho's resource identity for workspaces/peers/sessions IS the `name`
    (serialized as ``id`` over the API). There is no second, independent
    opaque id alongside it the way v4 carries ``id`` + ``name`` as separate
    columns. v4's own ``id`` for these three tables has nowhere to go.
  * ``SessionPeerConfig`` (the body of `POST .../sessions/{id}/peers`) has
    exactly two fields, ``observe_me``/``observe_others`` -- no
    ``joined_at``/``left_at``/``configuration``/``internal_metadata``. Those
    four v4 ``session_peers`` columns are unrepresentable over this API in
    either direction, not just unpreserved.
  * ``MessageCreate`` computes ``token_count`` server-side
    (``validate_and_set_token_count``, via ``tiktoken``) and has no
    client-settable ``token_count`` field. v4's stored ``token_count`` is
    therefore never sent and never comes back as the same value by
    definition, not as a migration bug.
  * ``Message`` exposes only ``public_id`` (aliased ``id``) over the API --
    v4's internal autoincrement ``messages.id`` has no Honcho-side twin.
  * v4's four +v4 nullable ``messages`` columns (``role``, ``in_reply_to``,
    ``read``, ``read_at``) have no Honcho schema field at all. This harness's
    export step (`bundle.py`) makes an explicit, visible choice to fold them
    into the ``metadata`` dict under a namespaced key rather than silently
    dropping them -- ``FakeHonchoTarget`` proves that choice actually
    survives a round trip (arbitrary ``metadata`` keys DO pass through
    unchanged), which is different from proving Honcho "supports" those
    columns.

``FakeHonchoTarget``'s token-count formula is a labelled stand-in
(``len(content.split())``), NOT ``tiktoken``'s ``o200k_base`` encoding --
this harness does not depend on ``tiktoken`` and does not claim to reproduce
the real count, only that a value the client sent is discarded and a
value the client did NOT send comes back in its place.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

import requests


@runtime_checkable
class HonchoTarget(Protocol):
    """The subset of the Honcho API this round trip exercises."""

    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]: ...

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]: ...

    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any]) -> dict[str, Any]: ...

    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]: ...

    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]: ...

    def list_peers(self, workspace_id: str) -> list[dict[str, Any]]: ...

    def get_session_peers(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]: ...

    def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]: ...


class HttpHonchoTarget:
    """Real HTTP client for a running Honcho instance. Untested against a
    live server in this session -- see the round-trip test module for why.
    """

    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        self._base = base_url.rstrip("/") + "/v3"  # src/main.py: every router mounted under /v3
        self._timeout = timeout_s

    def _post(self, path: str, body: Any) -> Any:
        resp = requests.post(f"{self._base}{path}", json=body, timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    def _get(self, path: str) -> Any:
        resp = requests.get(f"{self._base}{path}", timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    # routers/workspaces.py: POST /workspaces, body=WorkspaceCreate{id,metadata,configuration}
    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return self._post("/workspaces", {"id": workspace_id, "metadata": metadata, "configuration": configuration})

    # routers/peers.py: prefix /workspaces/{workspace_id}/peers, POST "" = PeerCreate{id,metadata,configuration}
    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/workspaces/{workspace_id}/peers", {"id": peer_id, "metadata": metadata, "configuration": configuration})

    # routers/sessions.py: prefix /workspaces/{workspace_id}/sessions, POST "" = SessionCreate{id,metadata}
    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
        return self._post(f"/workspaces/{workspace_id}/sessions", {"id": session_id, "metadata": metadata})

    # POST /workspaces/{workspace_id}/sessions/{session_id}/peers, body=dict[peer_id, SessionPeerConfig]
    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]:
        return self._post(f"/workspaces/{workspace_id}/sessions/{session_id}/peers", peers)

    # POST .../messages, body=MessageBatchCreate{messages:[MessageCreate...]}
    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return self._post(f"/workspaces/{workspace_id}/sessions/{session_id}/messages", {"messages": messages})

    # POST .../peers/list -> Page[Peer]
    def list_peers(self, workspace_id: str) -> list[dict[str, Any]]:
        page = self._post(f"/workspaces/{workspace_id}/peers/list", None)
        return page["items"]

    # GET .../sessions/{session_id}/peers -> Page[Peer]
    def get_session_peers(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        page = self._get(f"/workspaces/{workspace_id}/sessions/{session_id}/peers")
        return page["items"]

    # POST .../messages/list -> Page[Message]
    def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        page = self._post(f"/workspaces/{workspace_id}/sessions/{session_id}/messages/list", None)
        return page["items"]


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
        # No internal_metadata parameter exists on this call at all -- there is
        # nowhere for a caller to even try passing it, matching WorkspaceCreate.
        row = {"id": workspace_id, "metadata": dict(metadata), "configuration": dict(configuration)}
        self._workspaces[workspace_id] = row
        return row

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        row = {"id": peer_id, "workspace_id": workspace_id, "metadata": dict(metadata), "configuration": dict(configuration)}
        self._peers[(workspace_id, peer_id)] = row
        return row

    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
        row = {"id": session_id, "workspace_id": workspace_id, "metadata": dict(metadata)}
        self._sessions[(workspace_id, session_id)] = row
        self._session_peers.setdefault((workspace_id, session_id), {})
        return row

    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]:
        # SessionPeerConfig ONLY has observe_me/observe_others -- reject
        # anything else the same way a real Pydantic model would (extra keys
        # in a strict schema are the analogue; here we just refuse to store
        # them, so a caller that tries to smuggle joined_at through finds out
        # in the fake, not only in a live 422).
        allowed = {"observe_me", "observe_others"}
        bucket = self._session_peers.setdefault((workspace_id, session_id), {})
        for peer_id, cfg in peers.items():
            unknown = set(cfg) - allowed
            if unknown:
                raise ValueError(f"SessionPeerConfig has no field(s) {unknown} -- v3.2.0 schema only allows {allowed}")
            bucket[peer_id] = dict(cfg)
        return {"id": session_id, "workspace_id": workspace_id}

    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        bucket = self._messages.setdefault((workspace_id, session_id), [])
        for m in messages:
            if "token_count" in m:
                raise ValueError("MessageCreate has no client-settable token_count field in v3.2.0")
            if "id" in m:
                raise ValueError("MessageCreate has no client-settable internal id field in v3.2.0 -- only content/peer_id/metadata/configuration/created_at")
            public_id = f"msg-{self._next_public_id:04d}"
            self._next_public_id += 1
            fake = _FakeMessage(
                public_id=public_id,
                content=m["content"],
                peer_name=m["peer_id"],
                session_name=session_id,
                workspace_name=workspace_id,
                metadata=dict(m.get("metadata") or {}),
                created_at=m.get("created_at"),
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

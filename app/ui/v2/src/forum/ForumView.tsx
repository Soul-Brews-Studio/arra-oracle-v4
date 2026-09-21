import { useMemo, useState } from "react";
import type { MessageRow } from "../api/memory";
import { EmptyState } from "../components/EmptyState";
import { ErrorNote } from "../components/ErrorNote";
import { ReplyComposer } from "../components/ReplyComposer";
import { ThreadTree } from "../components/ThreadTree";
import { buildThreads } from "./threads";

/** Composes the forum pieces over one session's messages. Presentational
 *  plus one bit of local UI state -- which message is being replied to --
 *  same division `Transcript.tsx` draws: this file fetches nothing, that is
 *  `useMemory`'s job.
 *
 * This is the SAME rows the transcript view renders flat; here they're
 * grouped by `in_reply_to` instead. Two views over one truth, not two
 * stores. */
export function ForumView({
  messages,
  loading,
  error,
  peerName,
  onSend,
  sending,
}: {
  messages: MessageRow[];
  loading: boolean;
  error: string | null;
  peerName: string;
  onSend: (peerName: string, role: string | null, content: string, inReplyTo: string | null) => void;
  sending: boolean;
}) {
  const [replyingToId, setReplyingToId] = useState<string | null>(null);

  const threads = useMemo(() => buildThreads(messages), [messages]);
  const replyingTo = useMemo(
    () => (replyingToId === null ? null : messages.find((m) => m.public_id === replyingToId) ?? null),
    [messages, replyingToId],
  );

  if (loading) {
    return <EmptyState title="Loading" detail="Fetching messages for this session…" />;
  }

  const errorEnvelope = error !== null ? { message: error } : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {errorEnvelope && (
        <div className="p-3">
          <ErrorNote error={errorEnvelope} />
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        {messages.length === 0 && error === null ? (
          <EmptyState title="No messages" detail="This session has no messages yet." />
        ) : (
          <ThreadTree
            threads={threads}
            highlighted={new Set(replyingToId ? [replyingToId] : [])}
            onReply={setReplyingToId}
            replyingTo={replyingToId}
          />
        )}
      </div>
      <ReplyComposer
        replyingTo={replyingTo}
        peerName={peerName}
        onSend={(p, r, c, inReplyTo) => {
          onSend(p, r, c, inReplyTo);
          setReplyingToId(null);
        }}
        sending={sending}
        onCancel={() => setReplyingToId(null)}
      />
    </div>
  );
}

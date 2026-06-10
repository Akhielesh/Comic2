import React, { useEffect, useRef, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import type { ChatSession } from '../../services/chatStorage';
import { fetchFollowUps } from '../../services/chatApi';
import type { ChatRequest } from '../../apiTypes';
import { PILL, LABEL, HOVER_LIFT } from './studioDesign';

// Proactive follow-up suggestions. After the assistant finishes an answer, we ask a
// fast model what THIS user is most likely to want next and render those as clickable
// chips under the latest message — so the assistant feels forward-looking and helpful
// rather than passive. The chips are non-intrusive: they only appear after a completed
// assistant turn, vanish while a new turn is streaming, and silently render nothing
// when there's no useful suggestion (or no key configured).

const buildMessages = (session: ChatSession): ChatRequest['messages'] =>
  session.turns
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && !t.error && t.content.trim())
    .slice(-6)
    .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content.trim().slice(0, 8000) }));

export const FollowUpChips: React.FC<{
  session: ChatSession;
  busy: boolean;
  onSend: (text: string) => void;
}> = ({ session, busy, onSend }) => {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const lastTurn = session.turns[session.turns.length - 1];
  // Only suggest after a real, completed assistant answer.
  const ready = !busy && lastTurn?.role === 'assistant' && !lastTurn.error && Boolean(lastTurn.content.trim());
  const anchorId = ready ? lastTurn.id : '';
  // Track which anchor turn the current suggestions belong to, so we clear stale chips
  // immediately when a new turn starts (rather than showing last turn's follow-ups).
  const shownFor = useRef('');

  useEffect(() => {
    if (!anchorId) {
      if (suggestions.length) setSuggestions([]);
      return;
    }
    if (shownFor.current === anchorId) return; // already fetched for this turn
    shownFor.current = anchorId;
    setSuggestions([]);
    const ctrl = new AbortController();
    fetchFollowUps(buildMessages(session), session.source || undefined, { signal: ctrl.signal })
      .then((r) => {
        if (!ctrl.signal.aborted) setSuggestions((r.suggestions || []).slice(0, 4));
      })
      .catch(() => {
        /* best-effort — show nothing on failure */
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorId]);

  if (!ready || suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1 animate-fade-in" aria-label="Suggested follow-ups">
      <span className={`flex items-center gap-1 ${LABEL}`}>
        <Lightbulb className="h-3.5 w-3.5" /> You might ask
      </span>
      {suggestions.map((s) => (
        <button
          key={s}
          onClick={() => {
            setSuggestions([]); // consume — don't leave it lingering after sending
            onSend(s);
          }}
          className={`${PILL} px-3 py-1 text-[12px] font-medium hover:bg-[var(--ds-raised)] ${HOVER_LIFT}`}
        >
          {s}
        </button>
      ))}
    </div>
  );
};

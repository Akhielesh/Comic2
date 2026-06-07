// The Code Studio build conversation — your prompts + the agent's outcomes, rendered as a
// compact thread above the iterate composer. Driven by conversationStore. Messages are
// interactive: copy any message, or re-send one of your prompts to run it again.

import React, { useState } from 'react';
import { Loader2, Check, AlertTriangle, Copy, RefreshCw } from 'lucide-react';
import { useStudioTheme } from '../kit';
import { useStudioConversation } from './conversationStore';

export interface ConversationThreadProps {
  /** Re-run one of the user's prompts (the ↻ on a user bubble). */
  onResend?: (text: string) => void;
}

export const ConversationThread: React.FC<ConversationThreadProps> = ({ onResend }) => {
  const t = useStudioTheme();
  const messages = useStudioConversation((s) => s.messages);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  if (!messages.length) return null;

  const copy = (id: string, text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="space-y-1.5" aria-label="Build conversation">
      {messages.map((m) => {
        const isUser = m.role === 'user';
        return (
          <div key={m.id} className={`group flex items-center gap-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {/* Hover actions on the left for user bubbles (so they sit inside the row). */}
            {isUser && (
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                {onResend && (
                  <button
                    onClick={() => onResend(m.text)}
                    title="Run this prompt again"
                    aria-label="Resend prompt"
                    className={`rounded p-1 ${t.hover} ${t.textFaint} ${t.focusRing}`}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => copy(m.id, m.text)}
                  title="Copy"
                  aria-label="Copy message"
                  className={`rounded p-1 ${t.hover} ${t.textFaint} ${t.focusRing}`}
                >
                  {copiedId === m.id ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </span>
            )}

            <div
              className={`max-w-[88%] rounded-2xl border px-3 py-1.5 text-xs leading-snug ${t.edge} ${
                isUser ? `${t.panelAlt} ${t.text}` : `${t.panel} ${t.textDim}`
              }`}
            >
              {!isUser && (
                <span className="mr-1.5 inline-flex translate-y-px">
                  {m.status === 'pending' ? (
                    <Loader2 className="h-3 w-3 animate-spin text-violet-300" />
                  ) : m.status === 'error' ? (
                    <AlertTriangle className="h-3 w-3 text-rose-400" />
                  ) : (
                    <Check className="h-3 w-3 text-emerald-400" />
                  )}
                </span>
              )}
              <span className={m.status === 'error' ? 'text-rose-300' : ''}>{m.text}</span>
            </div>

            {/* Copy action for assistant bubbles. */}
            {!isUser && (
              <button
                onClick={() => copy(m.id, m.text)}
                title="Copy"
                aria-label="Copy message"
                className={`rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 ${t.hover} ${t.textFaint} ${t.focusRing}`}
              >
                {copiedId === m.id ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

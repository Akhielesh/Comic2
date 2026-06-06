// The Code Studio build conversation — your prompts + the agent's outcomes, rendered as a
// compact thread above the iterate composer. Driven by conversationStore.

import React from 'react';
import { Loader2, Check, AlertTriangle } from 'lucide-react';
import { useStudioTheme } from '../kit';
import { useStudioConversation } from './conversationStore';

export const ConversationThread: React.FC = () => {
  const t = useStudioTheme();
  const messages = useStudioConversation((s) => s.messages);
  if (!messages.length) return null;

  return (
    <div className="space-y-1.5" aria-label="Build conversation">
      {messages.map((m) => (
        <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`max-w-[88%] rounded-2xl border px-3 py-1.5 text-xs leading-snug ${t.edge} ${
              m.role === 'user' ? `${t.panelAlt} ${t.text}` : `${t.panel} ${t.textDim}`
            }`}
          >
            {m.role === 'assistant' && (
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
        </div>
      ))}
    </div>
  );
};

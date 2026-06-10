import React, { useEffect, useRef, useState } from 'react';
import type { ChatMsg } from './protocol';
import { EMOJI_SET } from './protocol';

const AVATAR_GRADIENTS = [
  ['#60a5fa', '#a78bfa'],
  ['#34d399', '#06b6d4'],
  ['#f472b6', '#fb7185'],
  ['#fbbf24', '#f97316'],
  ['#c084fc', '#818cf8'],
  ['#2dd4bf', '#22d3ee'],
];

export const avatarStyle = (name: string): React.CSSProperties => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const [a, b] = AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
  return { background: `linear-gradient(135deg, ${a}, ${b})` };
};

interface ChatPanelProps {
  messages: ChatMsg[];
  pinned: string | null;
  canModerate: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onEmoji: (e: string) => void;
  onDelete?: (id: string) => void;
}

export function ChatPanel({ messages, pinned, canModerate, disabled, onSend, onEmoji, onDelete }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <>
      {pinned && <div className="lv-pin">📌 {pinned}</div>}
      <div className="lv-chat" ref={listRef}>
        {messages.length === 0 && <div className="lv-sysmsg">no messages yet — say hi ✨</div>}
        {messages.map((m) => (
          <div className="lv-msg" key={m.id}>
            <div className="lv-avatar" style={avatarStyle(m.name)} />
            <div style={{ minWidth: 0 }}>
              <div className="lv-who">
                {m.name}
                {(m.role === 'mod' || m.role === 'host') && <span className="lv-role">{m.role}</span>}
              </div>
              <div className="lv-body">{m.text}</div>
            </div>
            {canModerate && onDelete && (
              <button className="lv-del" title="Delete message" onClick={() => onDelete(m.id)}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="lv-composer">
        <div className="lv-emoji-row">
          {EMOJI_SET.map((e) => (
            <button key={e} onClick={() => onEmoji(e)} disabled={disabled} aria-label={`react ${e}`}>
              {e}
            </button>
          ))}
        </div>
        <div className="lv-input-row">
          <input
            value={draft}
            disabled={disabled}
            placeholder="Say something…"
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
          />
          <button onClick={send} disabled={disabled}>
            Send
          </button>
        </div>
      </div>
    </>
  );
}

import React, { useState } from 'react';
import { Copy, Check, GitBranch, AlertTriangle, Sparkles, User, Globe, Brain } from 'lucide-react';
import { MessageBody } from '../MessageBody';
import type { ChatTurn } from '../../services/chatStorage';

interface ChatMessageViewProps {
  turn: ChatTurn;
  /** Branch a new conversation from this assistant turn. */
  onBranch?: () => void;
}

export const ChatMessageView: React.FC<ChatMessageViewProps> = ({ turn, onBranch }) => {
  const [copied, setCopied] = useState(false);
  const isUser = turn.role === 'user';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`shrink-0 w-9 h-9 rounded-full border-2 border-black flex items-center justify-center ${
          isUser ? 'bg-brand-blue text-white' : turn.error ? 'bg-red-100' : 'bg-brand-yellow'
        }`}
      >
        {isUser ? <User className="w-4 h-4" /> : turn.error ? <AlertTriangle className="w-4 h-4 text-brand-red" /> : <Sparkles className="w-4 h-4" />}
      </div>

      <div className={`min-w-0 max-w-[80%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`border-2 border-black rounded-xl px-4 py-2.5 shadow-comic ${
            isUser ? 'bg-white' : turn.error ? 'bg-red-50' : 'bg-slate-50'
          }`}
        >
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {turn.attachments.map((att) => (
                <img
                  key={att.id}
                  src={att.dataUrl}
                  alt={att.name}
                  className="w-20 h-20 object-cover rounded-lg border-2 border-black"
                />
              ))}
            </div>
          )}
          {isUser ? (
            <p className="whitespace-pre-wrap break-words text-sm">{turn.content}</p>
          ) : (
            <MessageBody text={turn.content || '…'} className="text-sm" />
          )}
        </div>

        {!isUser && !turn.error && (
          <div className="flex items-center gap-2 mt-1 px-1 text-[11px] text-slate-500">
            {turn.model && <span className="font-bold truncate max-w-[180px]">{turn.model}</span>}
            {turn.reasoningLevel && turn.reasoningLevel !== 'none' && (
              <span className="flex items-center gap-0.5"><Brain className="w-3 h-3" /> {turn.reasoningLevel}</span>
            )}
            {turn.webSearch && <span className="flex items-center gap-0.5"><Globe className="w-3 h-3" /> web</span>}
            <button onClick={handleCopy} className="flex items-center gap-0.5 hover:text-black font-bold" title="Copy answer">
              {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {onBranch && (
              <button onClick={onBranch} className="flex items-center gap-0.5 hover:text-black font-bold" title="Branch a new chat from here">
                <GitBranch className="w-3 h-3" /> Branch
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

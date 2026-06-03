import React, { useRef, useState } from 'react';
import { Send, Paperclip, X, Globe, Brain, Square, Loader2, LayoutGrid } from 'lucide-react';
import type { ChatReasoningLevel } from '../../apiTypes';
import type { ChatAttachment } from '../../services/chatStorage';
import { REASONING_LEVELS, type ChatModelFeatures } from '../../services/chatFeatures';

interface ChatComposerProps {
  busy: boolean;
  features: ChatModelFeatures;
  reasoningLevel: ChatReasoningLevel;
  webSearch: boolean;
  dreamstreamAccess: boolean;
  onReasoningChange: (level: ChatReasoningLevel) => void;
  onWebToggle: (on: boolean) => void;
  onDreamstreamToggle: (on: boolean) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
}

const MAX_ATTACHMENTS = 6;

const fileToAttachment = (file: File): Promise<ChatAttachment> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        dataUrl: reader.result as string
      });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export const ChatComposer: React.FC<ChatComposerProps> = ({
  busy,
  features,
  reasoningLevel,
  webSearch,
  dreamstreamAccess,
  onReasoningChange,
  onWebToggle,
  onDreamstreamToggle,
  onSend,
  onStop
}) => {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const next: ChatAttachment[] = [];
    for (const file of images.slice(0, MAX_ATTACHMENTS - attachments.length)) {
      try {
        next.push(await fileToAttachment(file));
      } catch {
        /* skip unreadable file */
      }
    }
    setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t-4 border-black bg-white p-3">
      {/* Feature toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {features.reasoning && (
          <label className="flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 bg-indigo-50">
            <Brain className="w-3.5 h-3.5" /> Reasoning
            <select
              value={reasoningLevel}
              onChange={(e) => onReasoningChange(e.target.value as ChatReasoningLevel)}
              className="bg-transparent outline-none font-bold cursor-pointer"
            >
              {REASONING_LEVELS.map((lvl) => (
                <option key={lvl.value} value={lvl.value}>{lvl.label}</option>
              ))}
            </select>
          </label>
        )}
        {features.webSearch && (
          <button
            onClick={() => onWebToggle(!webSearch)}
            className={`flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 ${webSearch ? 'bg-sky-300' : 'bg-white hover:bg-slate-100'}`}
            title="Search the live web while answering"
          >
            <Globe className="w-3.5 h-3.5" /> Web {webSearch ? 'on' : 'off'}
          </button>
        )}
        <button
          onClick={() => onDreamstreamToggle(!dreamstreamAccess)}
          className={`flex items-center gap-1.5 text-[11px] font-bold border-2 border-black rounded-full px-2.5 py-1 ${dreamstreamAccess ? 'bg-brand-yellow' : 'bg-white hover:bg-slate-100'}`}
          title="DreamStream connector: let this chat see your own projects, account and usage (read-only, sanitized). Off by default."
        >
          <LayoutGrid className="w-3.5 h-3.5" /> DreamStream {dreamstreamAccess ? 'on' : 'off'}
        </button>
      </div>

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <div key={att.id} className="relative">
              <img src={att.dataUrl} alt={att.name} className="w-14 h-14 object-cover rounded-lg border-2 border-black" />
              <button
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                className="absolute -top-1.5 -right-1.5 bg-brand-red text-white rounded-full border-2 border-black w-5 h-5 flex items-center justify-center"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {features.vision && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-white hover:bg-brand-yellow disabled:opacity-40"
              title="Attach images"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Message the model…  (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none border-2 border-black rounded-lg px-3 py-2.5 text-sm outline-none focus:shadow-comic-hover max-h-[200px]"
        />

        {busy ? (
          <button onClick={onStop} className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-brand-red text-white" title="Stop">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className="shrink-0 border-2 border-black rounded-lg p-2.5 bg-brand-yellow disabled:opacity-40 hover:translate-y-[1px]"
            title="Send"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
};

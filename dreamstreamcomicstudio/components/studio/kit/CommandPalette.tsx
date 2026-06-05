// CommandPalette (Sprint 4, S4.2): a ⌘K palette — fuzzy-filter a command list, arrow-key
// navigation, Enter to run, Esc to close. Themed + spring-animated; portals over everything.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Search, CornerDownLeft } from 'lucide-react';
import { useStudioTheme } from './themeStore';
import { usePrefersReducedMotion, springSoft } from './motion';
import { useDialogA11y } from './useDialogA11y';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, commands }) => {
  const t = useStudioTheme();
  const reduce = usePrefersReducedMotion();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogA11y(open, onClose);

  useEffect(() => {
    if (open) { setQuery(''); setSel(0); const id = setTimeout(() => inputRef.current?.focus(), 0); return () => clearTimeout(id); }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const toks = q.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
      return toks.every((tk) => hay.includes(tk));
    });
  }, [query, commands]);

  useEffect(() => { setSel(0); }, [query]);

  if (!open || typeof document === 'undefined') return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = filtered[sel]; if (c) { onClose(); c.run(); } }
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh] bg-black/50" onClick={onClose}>
      <motion.div
        initial={reduce ? false : { opacity: 0, y: -8, scale: 0.98 }}
        animate={reduce ? {} : { opacity: 1, y: 0, scale: 1 }}
        transition={springSoft}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className={`w-full max-w-lg rounded-xl border ${t.edgeStrong} ${t.panel} ${t.text} shadow-2xl overflow-hidden`}
      >
        <div className={`flex items-center gap-2 px-3 py-2.5 border-b ${t.edge}`}>
          <Search className={`w-4 h-4 ${t.textFaint}`} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command…"
            aria-label="Command"
            className={`flex-1 bg-transparent outline-none text-sm ${t.text}`}
          />
          <kbd className={`text-[10px] rounded border ${t.edge} px-1 ${t.textFaint}`}>Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 && <li className={`px-3 py-3 text-sm ${t.textFaint}`}>No matching commands.</li>}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                onMouseEnter={() => setSel(i)}
                onClick={() => { onClose(); c.run(); }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${i === sel ? `${t.accentSoft} ${t.text}` : `${t.textDim} ${t.hover}`}`}
              >
                {c.icon && <span className={i === sel ? t.accent : t.textFaint}>{c.icon}</span>}
                <span className="flex-1 truncate">{c.label}</span>
                {c.hint && <span className={`text-[11px] ${t.textFaint}`}>{c.hint}</span>}
                {i === sel && <CornerDownLeft className={`w-3.5 h-3.5 ${t.textFaint}`} />}
              </button>
            </li>
          ))}
        </ul>
      </motion.div>
    </div>,
    document.body
  );
};

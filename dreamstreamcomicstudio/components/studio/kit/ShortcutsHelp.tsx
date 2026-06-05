// ShortcutsHelp (Sprint 4): a small modal listing Code Studio keyboard shortcuts. Portaled,
// themed, spring-animated, reduced-motion safe.

import React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Keyboard } from 'lucide-react';
import { useStudioTheme } from './themeStore';
import { usePrefersReducedMotion, springSoft } from './motion';

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '⌘K', label: 'Command palette' },
  { keys: '⌘B', label: 'Build & run' },
  { keys: '⌘↵', label: 'Build & run' },
  { keys: '⌘S', label: 'Save (auto-saves on Build)' },
  { keys: 'Esc', label: 'Close dialogs' },
];

export const ShortcutsHelp: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useStudioTheme();
  const reduce = usePrefersReducedMotion();
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.97 }}
        animate={reduce ? {} : { opacity: 1, scale: 1 }}
        transition={springSoft}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        className={`w-full max-w-sm rounded-xl border ${t.edgeStrong} ${t.panel} ${t.text} shadow-2xl overflow-hidden`}
      >
        <div className={`flex items-center gap-2 px-4 py-3 border-b ${t.edge} font-bold`}>
          <Keyboard className={`w-4 h-4 ${t.accent}`} /> Keyboard shortcuts
        </div>
        <ul className="p-2">
          {SHORTCUTS.map((s, i) => (
            <li key={i} className={`flex items-center justify-between px-2 py-1.5 text-sm ${t.textDim}`}>
              <span>{s.label}</span>
              <kbd className={`rounded border ${t.edge} px-1.5 py-0.5 text-[11px] font-mono ${t.text}`}>{s.keys}</kbd>
            </li>
          ))}
        </ul>
      </motion.div>
    </div>,
    document.body
  );
};

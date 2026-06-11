import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// Expand-in-place lightbox: widgets (maps included) expand right where the user is —
// a focused overlay over the chat, same pattern as the video player — instead of
// hijacking the persistent right side panel. Portaled to <body>, Esc/backdrop closes,
// background scroll locked.

export const ExpandLightbox: React.FC<{
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, onClose, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm animate-fade-in sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Expanded widget'}
    >
      <div
        className="flex max-h-full w-full max-w-5xl animate-scale-in flex-col overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-4 py-2.5 backdrop-blur-md">
          <span className="min-w-0 truncate text-sm font-semibold text-[var(--ds-ink)]">{title || 'Expanded'}</span>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-lg p-1.5 text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">{children}</div>
      </div>
    </div>,
    document.body
  );
};

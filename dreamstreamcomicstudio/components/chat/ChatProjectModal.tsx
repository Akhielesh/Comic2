import React, { useState } from 'react';
import { X, Check } from 'lucide-react';
import { ModalPortal } from '../modals/ModalPortal';
import {
  PROJECT_ICONS, PROJECT_COLORS, iconByName, colorByKey,
  DEFAULT_PROJECT_ICON, DEFAULT_PROJECT_COLOR
} from '../../services/chatProjectStyle';
import type { ChatProject } from '../../services/chatStorage';

interface ChatProjectModalProps {
  /** Existing project to edit, or null to create a new one. */
  project: ChatProject | null;
  onSave: (name: string, icon: string, color: string) => void;
  onClose: () => void;
}

export const ChatProjectModal: React.FC<ChatProjectModalProps> = ({ project, onSave, onClose }) => {
  const [name, setName] = useState(project?.name || '');
  const [icon, setIcon] = useState(project?.icon || DEFAULT_PROJECT_ICON);
  const [color, setColor] = useState(project?.color || DEFAULT_PROJECT_COLOR);

  const HeaderIcon = iconByName(icon);
  const swatch = colorByKey(color);

  const save = () => {
    if (!name.trim()) return;
    onSave(name.trim(), icon, color);
  };

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
        <div
          className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-ink)] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.35)] backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-[var(--ds-hairline-soft)] px-5 py-4">
            <h2 className="text-base font-semibold">{project ? 'Edit project' : 'New project'}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-5 p-5">
            {/* Preview + name */}
            <div className="flex items-center gap-3">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white ${swatch.dot}`}>
                <HeaderIcon className="h-5 w-5" />
              </div>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                placeholder="Project name"
                className="min-w-0 flex-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-base font-medium text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] outline-none focus:border-[var(--ds-accent)] sm:text-sm"
              />
            </div>

            {/* Icon picker */}
            <div>
              <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-muted)]">Icon</div>
              <div className="grid grid-cols-7 gap-1.5">
                {PROJECT_ICONS.map(({ name: iconName, Icon }) => (
                  <button
                    key={iconName}
                    onClick={() => setIcon(iconName)}
                    aria-pressed={icon === iconName}
                    title={iconName}
                    className={`flex aspect-square items-center justify-center rounded-lg border transition-colors ${
                      icon === iconName
                        ? 'border-[var(--ds-accent)] bg-[#D97757]/10 text-[var(--ds-accent)]'
                        : 'border-[var(--ds-hairline-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </div>

            {/* Color picker */}
            <div>
              <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-muted)]">Color</div>
              <div className="flex flex-wrap gap-2.5 px-1 py-0.5">
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setColor(c.key)}
                    aria-pressed={color === c.key}
                    title={c.key}
                    className={`flex h-7 w-7 items-center justify-center rounded-full transition-transform ${c.dot} ${
                      color === c.key
                        ? 'outline outline-2 outline-offset-2 outline-[var(--ds-accent)]'
                        : 'hover:scale-110'
                    }`}
                  >
                    {color === c.key && <Check className="h-3.5 w-3.5 text-white" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-5 py-3.5">
            <button
              onClick={onClose}
              className="rounded-lg border border-[var(--ds-hairline)] px-4 py-2 text-sm font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!name.trim()}
              className="rounded-lg bg-[var(--ds-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
            >
              {project ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};

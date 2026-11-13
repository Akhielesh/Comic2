import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ds/Dialog';
import { Button } from '../ds/Button';
import { useKeyboardInset } from '../comicstudio/mobile/useKeyboardInset';
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
  useKeyboardInset();
  // This controlled dialog has several sidebar openers, rather than a DialogTrigger.
  const [opener] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-w-md flex-col gap-0 overflow-hidden p-0"
        scrimClassName="bottom-auto h-[var(--app-h,100dvh)]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
      >
        <header className="shrink-0 border-b border-[var(--ds-hairline-soft)] px-5 py-4 pr-14">
          <DialogTitle className="text-base">{project ? 'Edit project' : 'New project'}</DialogTitle>
        </header>
        <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-5">
          {/* Preview + name */}
          <div className="flex items-center gap-3">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white ${swatch.dot}`}>
              <HeaderIcon className="h-5 w-5" />
            </div>
            <input
              autoFocus
              aria-label="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save(); }}
              placeholder="Project name"
              className="min-w-0 flex-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-base font-medium text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] outline-none focus:border-[var(--ds-accent)] sm:text-sm"
            />
          </div>

          {/* Icon picker */}
          <div>
            <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-muted)]">Icon</div>
            <div role="group" aria-label="Project icon" className="grid grid-cols-[repeat(auto-fit,minmax(44px,1fr))] gap-1.5">
              {PROJECT_ICONS.map(({ name: iconName, Icon }) => (
                <button
                  key={iconName}
                  onClick={() => setIcon(iconName)}
                  aria-pressed={icon === iconName}
                  title={iconName}
                  aria-label={iconName}
                  className={`flex min-h-11 items-center justify-center rounded-lg border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ds-focus)] ${
                    icon === iconName
                      ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]'
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
            <div role="group" aria-label="Project color" className="flex flex-wrap gap-2 px-1 py-0.5">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setColor(c.key)}
                  aria-pressed={color === c.key}
                  title={c.key}
                  aria-label={c.key}
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ds-focus)] ${c.dot} ${
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

        <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-5 py-3.5">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!name.trim()}>{project ? 'Save' : 'Create'}</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
};

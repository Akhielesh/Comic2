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
      <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white border-4 border-black rounded-2xl shadow-comic w-full max-w-md" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b-4 border-black bg-brand-blue text-white rounded-t-xl">
            <h2 className="font-display text-xl">{project ? 'Edit project' : 'New project'}</h2>
            <button onClick={onClose} className="border-2 border-black rounded p-1 bg-white text-black hover:bg-brand-yellow"><X className="w-4 h-4" /></button>
          </div>

          <div className="p-5 space-y-4">
            {/* Preview + name */}
            <div className="flex items-center gap-3">
              <div className={`w-11 h-11 rounded-xl border-2 border-black flex items-center justify-center ${swatch.soft}`}>
                <HeaderIcon className="w-5 h-5" />
              </div>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                placeholder="Project name"
                className="flex-1 border-2 border-black rounded-lg px-3 py-2 text-sm font-bold outline-none focus:shadow-comic-hover"
              />
            </div>

            {/* Icon picker */}
            <div>
              <div className="text-[11px] font-bold uppercase text-slate-500 mb-1.5">Icon</div>
              <div className="grid grid-cols-7 gap-1.5">
                {PROJECT_ICONS.map(({ name: iconName, Icon }) => (
                  <button
                    key={iconName}
                    onClick={() => setIcon(iconName)}
                    className={`aspect-square rounded-lg border-2 flex items-center justify-center ${icon === iconName ? 'border-black bg-brand-yellow' : 'border-slate-300 bg-white hover:border-black'}`}
                  >
                    <Icon className="w-4 h-4" />
                  </button>
                ))}
              </div>
            </div>

            {/* Color picker */}
            <div>
              <div className="text-[11px] font-bold uppercase text-slate-500 mb-1.5">Color</div>
              <div className="flex flex-wrap gap-2">
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setColor(c.key)}
                    className={`w-7 h-7 rounded-full border-2 flex items-center justify-center ${c.dot} ${color === c.key ? 'border-black' : 'border-transparent hover:border-slate-400'}`}
                    title={c.key}
                  >
                    {color === c.key && <Check className="w-3.5 h-3.5 text-black" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 px-5 py-3 border-t-2 border-black">
            <button onClick={onClose} className="px-4 py-2 text-sm font-bold border-2 border-black rounded-lg bg-white hover:bg-slate-100">Cancel</button>
            <button
              onClick={save}
              disabled={!name.trim()}
              className="px-4 py-2 text-sm font-bold border-2 border-black rounded-lg bg-brand-yellow shadow-comic hover:translate-y-[1px] disabled:opacity-40"
            >
              {project ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};

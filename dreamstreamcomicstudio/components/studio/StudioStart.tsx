// StudioStart (Sprint 1, S1.7): the Code Studio home — a gallery of the user's saved
// projects (open / delete) shown when nothing is loaded into the workspace yet. Opening a
// project hydrates its files into the workspace store; the 3-pane workspace then takes over.

import React, { useEffect, useState } from 'react';
import { FolderOpen, Trash2, Loader2, MessageSquarePlus, RefreshCw, Copy } from 'lucide-react';
import { Reveal, Stagger, StaggerItem, Skeleton, Lift, EmptyState, useStudioTheme } from './kit';
import { TemplateLogo } from './assets/techLogos';
import { EmptyProjectsArt } from './assets/illustrations';
import { STARTER_TEMPLATES } from './assets/templates';
import { StudioWelcome } from './StudioWelcome';
import { useStudioWorkspace } from './workspace';
import {
  listStudioProjects, getStudioProject, deleteStudioProject, type StudioProjectSummary,
} from '../../services/studioApi';

const TEMPLATE_LABELS: Record<string, string> = {
  'react-ts': 'React + TS', react: 'React', 'vanilla-ts': 'TypeScript', vanilla: 'JavaScript', static: 'HTML/CSS',
};

const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
};

export interface StudioStartProps {
  /** Whether to suggest the chat hand-off (full studio is gated for non-admins). */
  onNavigate: (view: string) => void;
}

export const StudioStart: React.FC<StudioStartProps> = ({ onNavigate }) => {
  const t = useStudioTheme();
  const loadArtifact = useStudioWorkspace((s) => s.loadArtifact);
  const [projects, setProjects] = useState<StudioProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [dupId, setDupId] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setProjects(null);
    listStudioProjects()
      .then(setProjects)
      .catch((e) => { setError((e as Error)?.message || 'Could not load your projects.'); setProjects([]); });
  };
  useEffect(load, []);

  const open = async (id: string) => {
    setOpening(id);
    setError(null);
    try {
      const artifact = await getStudioProject(id);
      loadArtifact(artifact);
    } catch (e) {
      setError((e as Error)?.message || 'Could not open that project.');
    } finally {
      setOpening(null);
    }
  };

  // Duplicate: load the project's files as a fresh untitled copy (no id). The next Build saves
  // it as a new project — non-destructive to the original.
  const duplicate = async (id: string) => {
    setDupId(id);
    setError(null);
    try {
      const proj = await getStudioProject(id);
      loadArtifact({ title: `Copy of ${proj.title}`, template: proj.template, files: proj.files });
    } catch (e) {
      setError((e as Error)?.message || 'Could not duplicate that project.');
    } finally {
      setDupId(null);
    }
  };

  const remove = async (id: string) => {
    const prev = projects;
    setProjects((ps) => (ps ?? []).filter((p) => p.id !== id)); // optimistic
    try {
      await deleteStudioProject(id);
    } catch (e) {
      setProjects(prev ?? null); // rollback
      setError((e as Error)?.message || 'Could not delete that project.');
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6">
      <Reveal>
        <div className="mx-auto max-w-5xl">
          <StudioWelcome />
          <div className="flex items-center gap-3">
            <h1 className={`font-display text-2xl tracking-wide ${t.text}`}>Your projects</h1>
            <button onClick={load} title="Refresh" className={`rounded-md p-1.5 ${t.hover} ${t.textDim}`}>
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => onNavigate('chat')}
              className={`ml-auto inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3.5 py-1.5 ${t.accentText} ${t.accentBg} ${t.accentBgHover} ${t.focusRing}`}
            >
              <MessageSquarePlus className="w-4 h-4" /> Build from chat
            </button>
          </div>
          <p className={`mt-1 text-sm ${t.textDim}`}>Open a saved app to edit and run it, start from a template, or describe a new one in chat.</p>

          {/* Start from a template (S4.1) */}
          <div className="mt-5">
            <p className={`text-[11px] font-semibold uppercase tracking-wide ${t.textFaint}`}>Start from a template</p>
            <Stagger className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" step={0.04}>
              {STARTER_TEMPLATES.map((tpl) => (
                <StaggerItem key={tpl.id}>
                  <Lift>
                    <button
                      onClick={() => loadArtifact(tpl.artifact)}
                      className={`w-full text-left rounded-xl border ${t.edge} ${t.panel} p-4 ${t.hover} ${t.focusRing}`}
                    >
                      <div className="flex items-center gap-2">
                        <TemplateLogo template={tpl.artifact.template} className="w-4 h-4 shrink-0" />
                        <span className={`font-bold ${t.text}`}>{tpl.name}</span>
                      </div>
                      <p className={`mt-1 text-[11px] ${t.textFaint}`}>{tpl.description}</p>
                    </button>
                  </Lift>
                </StaggerItem>
              ))}
            </Stagger>
          </div>

          {error && <p className="mt-4 text-sm font-semibold text-rose-500">{error}</p>}

          {/* Loading */}
          {projects === null && (
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`rounded-xl border ${t.edge} ${t.panel} p-4`}>
                  <Skeleton className="h-4 w-2/3" /><Skeleton className="mt-3 h-3 w-1/3" />
                </div>
              ))}
            </div>
          )}

          {/* Empty */}
          {projects !== null && projects.length === 0 && !error && (
            <div className={`mt-8 rounded-2xl border ${t.edge} ${t.panel}`}>
              <EmptyState
                art={<EmptyProjectsArt />}
                title="No saved projects yet"
                description="Describe an app in chat and open it here — it saves automatically when you run it."
              >
                <button
                  onClick={() => onNavigate('chat')}
                  className={`inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-4 py-2 ${t.accentText} ${t.accentBg} ${t.accentBgHover} ${t.focusRing}`}
                >
                  <MessageSquarePlus className="w-4 h-4" /> Build from chat
                </button>
              </EmptyState>
            </div>
          )}

          {/* List */}
          {projects && projects.length > 0 && (
            <Stagger className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" step={0.04}>
              {projects.map((p) => (
                <StaggerItem key={p.id}>
                  <Lift>
                    <div className={`group relative rounded-xl border ${t.edge} ${t.panel} p-4`}>
                      <div className="flex items-start gap-2">
                        <TemplateLogo template={p.template} className="mt-0.5 w-4 h-4 shrink-0" />
                        <div className="min-w-0">
                          <p className={`font-bold truncate ${t.text}`}>{p.name}</p>
                          <p className={`text-[11px] ${t.textFaint}`}>
                            {TEMPLATE_LABELS[p.template] || p.template} · {relativeTime(p.updatedAt)}
                          </p>
                        </div>
                        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                          <button
                            onClick={() => duplicate(p.id)}
                            disabled={dupId === p.id}
                            title="Duplicate project"
                            aria-label={`Duplicate ${p.name}`}
                            className={`rounded p-1 ${t.hover} ${t.textDim}`}
                          >
                            {dupId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => remove(p.id)}
                            title="Delete project"
                            aria-label={`Delete ${p.name}`}
                            className={`rounded p-1 ${t.hover} text-rose-500`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      </div>
                      <button
                        onClick={() => open(p.id)}
                        disabled={opening === p.id}
                        className={`mt-4 inline-flex items-center gap-1.5 text-xs font-bold rounded-full border ${t.edgeStrong} px-3 py-1 ${t.text} ${t.hover} disabled:opacity-60 ${t.focusRing}`}
                      >
                        {opening === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
                        {opening === p.id ? 'Opening…' : 'Open'}
                      </button>
                    </div>
                  </Lift>
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>
      </Reveal>
    </div>
  );
};

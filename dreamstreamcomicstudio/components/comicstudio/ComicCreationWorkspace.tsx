import React, { useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, ChevronDown, FileText, Layers, Loader2, Menu, Palette, Plus, Settings, X } from 'lucide-react';
import type { Project } from '../../types';
import { useFormFactor } from './mobile/useFormFactor';
import { useFocusTrap } from './board/ui';
import { useDialogA11y } from '../studio/kit/useDialogA11y';
import { ModalPortal } from '../modals/ModalPortal';
import { useComicTheme } from './useComicTheme';
import { BrandLockup } from '../layout/BrandLockup';
import { ComicsMark } from '../comicshost/ComicsMark';
import '../comicshost/comicsShell.css';
import './comicCreationWorkspace.css';

export interface ComicProjectNavigationProps {
  projects: Project[];
  activeProjectId?: string | null;
  activeView?: 'new' | 'all';
  disabled?: boolean;
  onNewComic(): void;
  onAllComics(): void;
  onLibrary(): void;
  onOpenProject(id: string): void;
}

/** Shared with the studio's left navigation: every entry uses the existing App routing. */
export function ComicProjectNavigation({ projects, activeProjectId, activeView, disabled, onNewComic, onAllComics, onLibrary, onOpenProject }: ComicProjectNavigationProps) {
  const [recentOpen, setRecentOpen] = useState(true);
  const recentId = useId();
  const recent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  return <nav className="comic-project-nav" aria-label="Your comics">
    <button type="button" className="comic-project-new comics-primary-action" onClick={onNewComic} disabled={disabled} aria-current={activeView === 'new' ? 'page' : undefined}><Plus aria-hidden />New comic</button>
    <button type="button" className="comic-project-recents-toggle" aria-expanded={recentOpen} aria-controls={recentId} onClick={() => setRecentOpen(!recentOpen)}><ChevronDown aria-hidden className={recentOpen ? '' : 'is-closed'} />Recent comics</button>
    {recentOpen && <div id={recentId} className="comic-project-recents">
      {recent.map((project) => <button type="button" key={project.id} disabled={disabled} onClick={() => onOpenProject(project.id)} aria-current={activeProjectId === project.id ? 'page' : undefined} title={project.name}><FileText aria-hidden /><span>{project.name || 'Untitled comic'}</span></button>)}
      {!recent.length && <p>Your comics will appear here.</p>}
    </div>}
    <div className="comic-project-destinations">
      <button type="button" disabled={disabled} onClick={onAllComics} aria-current={activeView === 'all' ? 'page' : undefined}><Layers aria-hidden />All comics</button>
      <button type="button" disabled={disabled} onClick={onLibrary}><BookOpen aria-hidden />Library</button>
    </div>
  </nav>;
}

const NAV_KEY = 'comicstudio.creation.navigation';
const readNav = () => { try { return localStorage.getItem(NAV_KEY) !== 'closed'; } catch { return true; } };

export function ComicWorkspaceFrame({ children, title, navigation, onHome, onAccount }: {
  children: React.ReactNode; title: string; navigation: ComicProjectNavigationProps; onHome(): void; onAccount(): void;
}) {
  const ff = useFormFactor();
  const narrow = ff.width < 900;
  const [wideOpen, setWideOpen] = useState(readNav);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const navId = useId();
  const { theme, setTheme } = useComicTheme();
  const modalOpen = narrow && drawerOpen;
  const close = () => setDrawerOpen(false);
  useDialogA11y(modalOpen, close);
  useFocusTrap(drawerRef, modalOpen);
  const route = (action: () => void) => () => { close(); action(); };
  const links: ComicProjectNavigationProps = { ...navigation,
    onNewComic: route(navigation.onNewComic), onAllComics: route(navigation.onAllComics), onLibrary: route(navigation.onLibrary),
    onOpenProject: (id) => { close(); navigation.onOpenProject(id); } };
  const brand = <BrandLockup className="comic-workspace-brand" mark={<ComicsMark size={28} />} name="Comic" suffix="Studio" suffixAlways label="Comic Studio, home" onClick={route(onHome)} />;
  const toggle = () => {
    if (narrow) setDrawerOpen((open) => !open);
    else setWideOpen((open) => { try { localStorage.setItem(NAV_KEY, open ? 'closed' : 'open'); } catch { /* Session only. */ } return !open; });
  };
  return <div className="comic-creation-workspace" data-ds-skin="atlas">
    {!narrow && wideOpen && <aside id={navId} className="comic-workspace-sidebar">{brand}<ComicProjectNavigation {...links} /></aside>}
    <div className="comic-workspace-body" inert={modalOpen || undefined}>
      <header className="comic-workspace-header">
        <button type="button" className="comic-workspace-icon" onClick={toggle} aria-expanded={narrow ? drawerOpen : wideOpen} aria-controls={navId} aria-label={narrow ? 'Open comic navigation' : wideOpen ? 'Collapse comic navigation' : 'Expand comic navigation'}><Menu aria-hidden /></button>
        <span className="comic-workspace-title">{title}</span>
        <button type="button" className="comic-workspace-icon" onClick={() => setTheme(theme === 'paper' ? 'atlas' : 'paper')} aria-label={theme === 'paper' ? 'Use Atlas theme' : 'Use Paper theme'}><Palette aria-hidden /></button>
        <button type="button" className="comic-workspace-icon" onClick={onAccount} aria-label="Open account settings"><Settings aria-hidden /></button>
      </header>
      <main className="comic-workspace-content">{children}</main>
    </div>
    {modalOpen && <ModalPortal><div className="comic-workspace-drawer-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div id={navId} ref={drawerRef} role="dialog" aria-modal="true" aria-label="Comic navigation" tabIndex={-1} className="comic-workspace-sidebar comic-workspace-drawer">
        <button type="button" className="comic-workspace-icon comic-workspace-drawer-close" onClick={close} aria-label="Close comic navigation"><X aria-hidden /></button>
        {brand}<ComicProjectNavigation {...links} />
      </div>
    </div></ModalPortal>}
  </div>;
}

export interface ComicIdeaFormProps {
  name: string; idea: string; pending: boolean; error: string | null;
  onName(value: string): void; onIdea(value: string): void;
  onStart(): void; onStartBlank(): void; onClassic(): void; onLibrary(): void;
}

export function ComicIdeaForm({ name, idea, pending, error, onName, onIdea, onStart, onStartBlank, onClassic, onLibrary }: ComicIdeaFormProps) {
  const id = useId();
  return <section className="comic-idea-entry" aria-labelledby={`${id}-heading`}>
    <button type="button" className="comic-idea-preview" onClick={onLibrary} disabled={pending} aria-label="Explore sample comics in the Library">
      <img src="/assets/comic-sample/last-tram-page-1-480.webp" alt="" width="480" height="400" />
      <span>Explore sample comics <ArrowRight aria-hidden /></span>
    </button>
    <h1 id={`${id}-heading`}>What comic are you making?</h1>
    <p className="comic-idea-intro">Describe an idea or paste a script.</p>
    <form className="comic-idea-form" onSubmit={(event) => { event.preventDefault(); if (idea.trim() && !pending) onStart(); }}>
      <label htmlFor={`${id}-name`}>Comic name <span>(optional)</span></label>
      <input id={`${id}-name`} value={name} onChange={(event) => onName(event.target.value)} maxLength={200} disabled={pending} placeholder="e.g. The Last Observatory" />
      <div className="comic-idea-compose">
        <label className="sr-only" htmlFor={`${id}-idea`}>Your comic idea or script</label>
        <textarea id={`${id}-idea`} value={idea} onChange={(event) => onIdea(event.target.value)} disabled={pending} maxLength={200000} placeholder="Describe your idea or paste a script here…" aria-describedby={`${id}-help`} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && idea.trim() && !pending) { event.preventDefault(); onStart(); } }} />
        <div className="comic-idea-compose-actions"><button type="submit" className="comic-idea-start comics-primary-action" disabled={!idea.trim() || pending}>{pending ? <><Loader2 className="animate-spin" aria-hidden />Preparing…</> : <>Start <ArrowRight aria-hidden /></>}</button></div>
      </div>
      {error && <p className="comic-idea-error" role="alert">{error}</p>}
      <p id={`${id}-help`} className="comic-idea-help">Start prepares the conversation. Send submits your idea.</p>
      <div className="comic-idea-alternatives"><button type="button" onClick={onStartBlank} disabled={pending}>Start blank</button><button type="button" onClick={onClassic} disabled={pending}>Use the classic editor</button></div>
    </form>
  </section>;
}

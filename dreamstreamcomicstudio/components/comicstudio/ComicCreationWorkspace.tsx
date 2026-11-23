import React, { useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Bug, CircleHelp, ChevronDown, FileText, Image as ImageIcon, Layers, Loader2, Menu, MessageCircle, Plus, X } from 'lucide-react';
import type { Project } from '../../types';
import { useFormFactor } from './mobile/useFormFactor';
import { useFocusTrap } from './board/ui';
import { useDialogA11y } from '../studio/kit/useDialogA11y';
import { ModalPortal } from '../modals/ModalPortal';
import { AccountMenu } from '../account/AccountMenu';
import { IconButton } from '../ds/IconButton';
import { ComicStudioBrand } from '../comicshost/ComicStudioBrand';
import { ComicTaskActivity } from './home/ComicTaskActivity';
import { openFeedbackReport } from '../../services/openFeedbackReport';
import { HOME_START_HELP } from './home/homeModel';
import '../comicshost/comicsShell.css';
import './comicCreationWorkspace.css';

export interface ComicProjectNavigationProps {
  projects: Project[];
  accountId?: string;
  onOpenStudioWork?(id: string): void;
  onReport?(): void;
  activeProjectId?: string | null;
  activeView?: 'new' | 'all';
  disabled?: boolean;
  onNewComic(): void;
  onImages?(): void;
  onChat?(): void;
  onAllComics(): void;
  onLibrary(): void;
  onOpenProject(id: string): void;
}

/** Shared with the studio's left navigation: every entry uses the existing App routing. */
export function ComicProjectNavigation({ projects, accountId, onOpenStudioWork, onReport, activeProjectId, activeView, disabled, onNewComic, onImages, onChat, onAllComics, onLibrary, onOpenProject }: ComicProjectNavigationProps) {
  const [recentOpen, setRecentOpen] = useState(true);
  const recentId = useId();
  const recent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  return <nav className="comic-project-nav" aria-label="Your comics">
    <button type="button" className="comic-project-new" onClick={onNewComic} disabled={disabled} aria-current={activeView === 'new' ? 'page' : undefined}><Plus aria-hidden />New comic</button>
    {onImages && <button type="button" onClick={onImages} disabled={disabled}><ImageIcon aria-hidden />Standalone images</button>}
    {onChat && <button type="button" onClick={onChat} disabled={disabled}><MessageCircle aria-hidden />Open chat</button>}
    {accountId && <ComicTaskActivity key={accountId} accountId={accountId} disabled={disabled} onOpen={onOpenStudioWork ?? onOpenProject} />}
    <button type="button" className="comic-project-recents-toggle" aria-expanded={recentOpen} aria-controls={recentId} onClick={() => setRecentOpen(!recentOpen)}><ChevronDown aria-hidden className={recentOpen ? '' : 'is-closed'} />Recent comics</button>
    {recentOpen && <div id={recentId} className="comic-project-recents">
      {recent.map((project) => <button type="button" key={project.id} disabled={disabled} onClick={() => onOpenProject(project.id)} aria-current={activeProjectId === project.id ? 'page' : undefined} title={project.name}><FileText aria-hidden /><span>{project.name || 'Untitled comic'}</span></button>)}
      {!recent.length && <p>Your comics will appear here.</p>}
    </div>}
    <div className="comic-project-destinations">
      <button type="button" disabled={disabled} onClick={onAllComics} aria-current={activeView === 'all' ? 'page' : undefined}><Layers aria-hidden />All comics</button>
      <button type="button" disabled={disabled} onClick={onLibrary}><BookOpen aria-hidden />Library</button>
      <a href="/?tour=1"><CircleHelp aria-hidden />Studio guide</a>
      <button type="button" disabled={disabled} onClick={onReport ?? (() => openFeedbackReport('bug'))}><Bug aria-hidden />Report a problem</button>
    </div>
  </nav>;
}

/** Below this width the frame's navigation (and its New comic) is a drawer, not a sidebar. */
export const WORKSPACE_NAV_DRAWER_BELOW = 900;

const NAV_KEY = 'comicstudio.creation.navigation';
const readNav = () => { try { return localStorage.getItem(NAV_KEY) !== 'closed'; } catch { return true; } };

export function ComicWorkspaceFrame({ children, title, navigation, onHome }: {
  children: React.ReactNode; title: string; navigation: ComicProjectNavigationProps; onHome(): void;
  /** Unused: the header's account menu opens Settings (navtheme NT-2a). Kept so callers compile. */
  onAccount?(): void;
}) {
  const ff = useFormFactor();
  const narrow = ff.width < WORKSPACE_NAV_DRAWER_BELOW;
  const [wideOpen, setWideOpen] = useState(readNav);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const navId = useId();
  const modalOpen = narrow && drawerOpen;
  const close = () => setDrawerOpen(false);
  useDialogA11y(modalOpen, close);
  useFocusTrap(drawerRef, modalOpen);
  const route = (action: () => void) => () => { close(); action(); };
  const links: ComicProjectNavigationProps = { ...navigation,
    onReport: route(navigation.onReport ?? (() => openFeedbackReport('bug'))),
    onOpenStudioWork: navigation.onOpenStudioWork && ((id) => { close(); navigation.onOpenStudioWork!(id); }),
    onImages: navigation.onImages && route(navigation.onImages),
    onChat: navigation.onChat && route(navigation.onChat),
    onNewComic: route(navigation.onNewComic), onAllComics: route(navigation.onAllComics), onLibrary: route(navigation.onLibrary),
    onOpenProject: (id) => { close(); navigation.onOpenProject(id); } };
  const brand = <ComicStudioBrand className="comic-workspace-brand" onHome={route(onHome)} />;
  const toggle = () => {
    if (narrow) setDrawerOpen((open) => !open);
    else setWideOpen((open) => { try { localStorage.setItem(NAV_KEY, open ? 'closed' : 'open'); } catch { /* Session only. */ } return !open; });
  };
  return <div className="comic-creation-workspace" data-ds-skin="atlas">
    {!narrow && wideOpen && <aside id={navId} className="comic-workspace-sidebar">{brand}<ComicProjectNavigation {...links} /></aside>}
    <div className="comic-workspace-body" inert={modalOpen || undefined}>
      <header className="comic-workspace-header">
        <IconButton className="comic-workspace-icon" title={null} onClick={toggle} aria-expanded={narrow ? drawerOpen : wideOpen} aria-controls={navId} label={narrow ? 'Open comic navigation' : wideOpen ? 'Collapse comic navigation' : 'Expand comic navigation'}><Menu /></IconButton>
        {(narrow || !wideOpen) && <ComicStudioBrand className="comic-workspace-header-brand" onHome={route(onHome)} />}
        <span className="comic-workspace-title">{title}</span>
        {/* The account menu at the right end, the same as the comics header's; Back from Settings returns to New comic. */}
        <AccountMenu paper resume={navigation.activeView === 'new' ? 'new-comic' : undefined} />
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
  onStart(): void; onDraft(): void; onStartBlank(): void; onClassic(): void; onLibrary(): void; onImages?(): void;
}

const STORY_STARTERS = [
  { title: 'The night tram', story: 'last-tram', prompt: 'A night tram stops at a platform missing from every map. One passenger recognizes it.' },
  { title: 'A signal from the ice', story: 'hello-europa', prompt: 'An astronaut hears a familiar voice beneath the ice of Europa. The nearest station has been empty for years.' },
  { title: 'The smallest rescuer', story: 'a-small-giant', prompt: 'When a storm washes away the forest bridge, a mouse finds a way across that the larger animals overlooked.' }
] as const;

const SCRIPT_LIMIT = 200000;

export function ComicIdeaForm({ name, idea, pending, error, onName, onIdea, onStart, onDraft, onStartBlank, onClassic, onLibrary, onImages }: ComicIdeaFormProps) {
  const id = useId();
  const script = useRef<HTMLTextAreaElement>(null);
  const hasScript = Boolean(idea.trim());
  const canStart = !pending && hasScript;
  const starterPrefix = hasScript ? `${idea}\n\n` : '';
  return <section className="comic-idea-entry" aria-labelledby={`${id}-heading`}>
    <div className="comic-idea-writing">
      <h1 id={`${id}-heading`}>What comic are you making?</h1>
      <p className="comic-idea-intro">Describe a scene, paste a script, or try an illustrated story starter.</p>
      <form className="comic-idea-form" onSubmit={event => {
        event.preventDefault();
        if (canStart) onDraft();
      }}>
        <div className="comic-idea-compose">
          <label className="sr-only" htmlFor={`${id}-idea`}>Your comic idea or script</label>
          <textarea
            ref={script} id={`${id}-idea`} value={idea} onChange={event => onIdea(event.target.value)}
            disabled={pending} maxLength={SCRIPT_LIMIT} aria-describedby={`${id}-help`}
            placeholder="A lighthouse keeper receives a letter from a ship that vanished years ago…"
            onKeyDown={event => {
              if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (canStart && !event.repeat) event.currentTarget.form?.requestSubmit();
            }}
          />
          <p id={`${id}-help`} className="comic-idea-help">{HOME_START_HELP}</p>
          <div className="comic-idea-compose-actions">
            <button type="submit" className="comic-idea-start" disabled={!canStart}>{pending ? <><Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />Preparing…</> : <>Draft it for me <ArrowRight aria-hidden /></>}</button>
            <button type="button" className="comic-idea-hands-on" disabled={!canStart} onClick={onStart}>Work step by step</button>
          </div>
        </div>
        {error && <p className="comic-idea-error" role="alert">{error}</p>}
        <details className="comic-idea-options">
          <summary>Project options</summary>
          <label htmlFor={`${id}-name`}>Comic name <span>(optional)</span></label>
          <input id={`${id}-name`} value={name} onChange={(event) => onName(event.target.value)} maxLength={200} disabled={pending} placeholder="e.g. The Last Observatory" />
          <div className="comic-idea-alternatives"><button type="button" onClick={onStartBlank} disabled={pending}>Start blank</button><button type="button" onClick={onClassic} disabled={pending}>Use the classic editor</button></div>
        </details>
        {onImages && <button className="comic-idea-image-link" type="button" onClick={onImages} disabled={pending}><ImageIcon aria-hidden />Create a standalone image</button>}
      </form>
    </div>
    <aside className="comic-story-starters" aria-labelledby={`${id}-starters`}>
      <div className="comic-starters-heading"><h2 id={`${id}-starters`}>Story starters</h2><button type="button" onClick={onLibrary} disabled={pending}>Library <ArrowRight aria-hidden /></button></div>
      <p>Choose a premise to add to your script.</p>
      <div className="comic-starter-strip">
        {STORY_STARTERS.map(({ title, story, prompt }) => (
          <button type="button" key={story} className="comic-starter-panel" disabled={pending || starterPrefix.length + prompt.length > SCRIPT_LIMIT} aria-label={`Add ${title} to your script`}
            onClick={() => {
              onIdea(starterPrefix + prompt);
              script.current?.focus();
            }}>
            <span className="comic-starter-art" data-comic-art=""><img src={`/assets/comic-sample/${story}-page-1-480.webp`} alt="" width={480} height={320} /></span>
            <span className="comic-starter-caption">{title}<Plus aria-hidden /></span>
          </button>
        ))}
      </div>
    </aside>
  </section>;
}

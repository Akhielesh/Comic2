import React, { useId, useRef, useState } from 'react';
import { ArrowRight, Image as ImageIcon, Loader2, Menu, Plus, X } from 'lucide-react';
import { useFormFactor } from './mobile/useFormFactor';
import { useFocusTrap } from './board/ui';
import { useDialogA11y } from '../studio/kit/useDialogA11y';
import { ModalPortal } from '../modals/ModalPortal';
import { AccountMenu } from '../account/AccountMenu';
import { IconButton } from '../ds/IconButton';
import { ComicStudioBrand } from '../comicshost/ComicStudioBrand';
import { ComicSidePanel, PANEL_LABEL, type ComicPanelLinks, type PanelPlace } from './panel/ComicSidePanel';
import { usePanelOpen } from './panel/panelPreference';
import { openFeedbackReport } from '../../services/openFeedbackReport';
import { HOME_START_HELP } from './home/homeModel';
import '../comicshost/comicsShell.css';
import './comicCreationWorkspace.css';

/** The panel's links (App's routing); `activeView` names the frame's view. */
export type ComicProjectNavigationProps = ComicPanelLinks;

/** Below this width the frame's panel (and its New comic) is a drawer, not a column. */
export const WORKSPACE_NAV_DRAWER_BELOW = 900;

const placeOf = (view: ComicPanelLinks['activeView']): PanelPlace => (view === 'new' ? 'new' : view === 'images' ? 'images' : 'all');

/**
 * The frame around My comics (All comics), New comic and Images: the studio's header, and the one side panel
 * (components/comicstudio/panel) docked open or as a slim rail from 900 px, a drawer below. Open or rail is the viewer's
 * one choice for the whole studio (panelPreference.ts); the frame starts open wherever it docks.
 */
export function ComicWorkspaceFrame({ children, title, navigation, onHome }: {
  children: React.ReactNode; title: string; navigation: ComicProjectNavigationProps; onHome(): void;
}) {
  const ff = useFormFactor();
  const narrow = ff.width < WORKSPACE_NAV_DRAWER_BELOW;
  // Open by default wherever the column docks (the frame's content has the room); the viewer's choice wins.
  const [wideOpen, setWideOpen] = usePanelOpen(navigation.accountId, ff.width, WORKSPACE_NAV_DRAWER_BELOW);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const navId = useId();
  const modalOpen = narrow && drawerOpen;
  const close = () => setDrawerOpen(false);
  useDialogA11y(modalOpen, close);
  useFocusTrap(drawerRef, modalOpen);
  const route = (action: () => void) => () => { close(); action(); };
  const links: ComicPanelLinks = { ...navigation,
    onReport: route(navigation.onReport ?? (() => openFeedbackReport('bug'))),
    onOpenStudioWork: navigation.onOpenStudioWork && ((id) => { close(); navigation.onOpenStudioWork!(id); }),
    onImages: navigation.onImages && route(navigation.onImages),
    onChat: navigation.onChat && route(navigation.onChat),
    onNewComic: route(navigation.onNewComic), onAllComics: route(navigation.onAllComics), onLibrary: route(navigation.onLibrary),
    onOpenProject: (id) => { close(); navigation.onOpenProject(id); } };
  const place = placeOf(navigation.activeView);
  const brand = <ComicStudioBrand className="comic-workspace-brand" onHome={route(onHome)} />;
  const toggle = () => {
    if (narrow) setDrawerOpen((open) => !open);
    else setWideOpen(!wideOpen);
  };
  return <div className="comic-creation-workspace" data-ds-skin="atlas">
    {!narrow && wideOpen && <aside className="comic-workspace-sidebar">{brand}<ComicSidePanel id={navId} place={place} links={links} className="h-auto flex-1" /></aside>}
    <div className="comic-workspace-body" inert={modalOpen || undefined}>
      <header className="comic-workspace-header">
        <IconButton className="comic-workspace-icon" title={null} onClick={toggle} aria-expanded={narrow ? drawerOpen : wideOpen} aria-controls={!narrow || drawerOpen ? navId : undefined} aria-haspopup={narrow ? 'dialog' : undefined} label={narrow ? 'Open project navigation' : wideOpen ? 'Collapse project navigation' : 'Expand project navigation'}><Menu /></IconButton>
        {(narrow || !wideOpen) && <ComicStudioBrand className="comic-workspace-header-brand" onHome={route(onHome)} />}
        <span className="comic-workspace-title">{title}</span>
        {/* The account menu at the right end, the same as the comics header's; Back from Settings returns to New comic. */}
        <AccountMenu paper resume={navigation.activeView === 'new' ? 'new-comic' : undefined} />
      </header>
      <div className="comic-workspace-row">
        {/* Collapsed, the panel is a slim rail under the header, as in the studio. */}
        {!narrow && !wideOpen && <aside className="comic-workspace-rail"><ComicSidePanel id={navId} place={place} links={links} compact /></aside>}
        <main className="comic-workspace-content">{children}</main>
      </div>
    </div>
    {modalOpen && <ModalPortal><div className="comic-workspace-drawer-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={drawerRef} role="dialog" aria-modal="true" aria-label={PANEL_LABEL} tabIndex={-1} className="comic-workspace-sidebar comic-workspace-drawer">
        <button type="button" className="comic-workspace-icon comic-workspace-drawer-close" onClick={close} aria-label="Close project navigation"><X aria-hidden /></button>
        {brand}<ComicSidePanel id={navId} place={place} links={links} className="h-auto flex-1" />
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

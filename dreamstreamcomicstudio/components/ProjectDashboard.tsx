import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { Plus, BookOpen, Edit, Trash2, Copy, Sparkles, CheckCircle2, XCircle, AlertTriangle, Info, Star, Filter, Calendar, ArrowDownAZ, ArrowUpAZ, Clock, Loader2, MessageSquare, Pencil, X } from 'lucide-react';
import { AppStep, Project } from '../types';
import { Badge, Button, IconButton, Input, INPUT_CLASSES, Select } from './ds';
import { FIELD_LABEL } from './ds/Field';
import { FILTER_CHIP, FILTER_CHIP_ON } from './ds/FilterChips';
import {
  CHIP,
  FOCUS_RING,
  HEADING,
  LIFT,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RISE_IN,
  CANVAS_BG,
  SCRIM,
  SHADOW_SOFT,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_3XL,
  INVERSE_SURFACE,
  OVERLAY,
  Z
} from './chat/studioDesign';
import { cn } from '../lib/utils';
// Lazy load ProjectInfoModal
const ProjectInfoModal = React.lazy(() => import('./modals/ProjectInfoModal').then(module => ({ default: module.ProjectInfoModal })));
import { DataRescue } from './DataRescue';
import { ReadinessChecklist } from './ReadinessChecklist';
import { getFluxKeyInfo } from '../services/appSettings';
import { SmartImage } from './common/SmartImage';
import { LoadingState } from './ds/LoadingState';
import { streamStudio } from './comicstudio/studioApi';
import { formatStudioProgress, isStudioV4Project, studioPageProgress } from '../services/studioDeepLink';
import { ComicIdeaForm, ComicWorkspaceFrame, WORKSPACE_NAV_DRAWER_BELOW } from './comicstudio/ComicCreationWorkspace';
import { useFormFactor } from './comicstudio/mobile/useFormFactor';
import { useComicIdeaDraft } from './comicstudio/comicIdeaDraft';
import { ContinueCard } from './comicstudio/home/ContinueCard';
import { OwnKeyLimitLine } from './comicstudio/home/OwnKeyLimitLine';
import { coverCandidates, pickContinue } from './comicstudio/home/homeModel';

/** How a new comic starts: the conversational Comic Studio (default) or a classic pipeline. */
export type NewComicMode = 'studio' | 'classic' | 'pagestudio';

/** Project names are capped server-side at 200 characters. */
const PROJECT_NAME_MAX = 200;

export const DUPLICATE_UNAVAILABLE_FOR_STUDIO = "Duplicate isn't available for studio comics yet";

/**
 * A comic card's Read / Open / Info row on a touch screen. With a mouse the row sits centred on a dimmed cover and
 * shows while the card is hovered, or when the keyboard reaches one of its buttons (`:focus-visible`; a mouse click
 * focuses a button too and must not hold the row open). A touch screen has no hover, so there the row is always
 * shown: along the bottom of the cover on a light scrim, each button at least 44 px.
 *
 * "A touch screen" is every screen that is not a mouse: the opposite of the app's `can-hover` screen
 * (tailwind.config.cjs, `(hover: hover) and (pointer: fine)`). That takes in a phone that claims it can hover and a
 * pen-only screen, which `(hover: none)` or `(pointer: coarse)` alone would each miss. Tailwind cannot build a
 * variant with a comma in it, so the query is written as `not all and ...`.
 *
 * What a cover centres (the empty-cover marks, the Generating notice) moves up by the row's height there
 * (`CARD_COVER_TOUCH`), so the row never sits on it; on the smallest phones that leaves the notice short of room, so
 * its progress bar keeps its height (`shrink-0`). On a 320 px phone a button is 72 px wide, so its side padding
 * drops to 4 px to keep the label inside (written against the small Button's own `has-[>svg]:` padding, which it
 * must outrank). The classes are written out in full because Tailwind reads them from this
 * file.
 */
const CARD_ACTIONS_TOUCH = '[@media_not_all_and_(hover:hover)_and_(pointer:fine)]:top-auto [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:bg-transparent [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:bg-gradient-to-t [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:from-[var(--ds-scrim)] [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:px-2 [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:pb-2 [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:pt-6 [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:opacity-100';
const CARD_ACTION_TOUCH = '[@media_not_all_and_(hover:hover)_and_(pointer:fine)]:min-h-[44px] [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:min-w-[44px] [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:flex-1 [@media_not_all_and_(hover:hover)_and_(pointer:fine)]:has-[>svg]:px-1';
const CARD_COVER_TOUCH = '[@media_not_all_and_(hover:hover)_and_(pointer:fine)]:pb-16';
const CARD_BAR_TOUCH = '[@media_not_all_and_(hover:hover)_and_(pointer:fine)]:shrink-0';

/** A filter toggle in the search bar (Featured, Recent Changes, Has Cover, Has Comments): an outline chip, ink while on. */
const filterToggle = (on: boolean): string =>
  cn(FILTER_CHIP, on ? FILTER_CHIP_ON : 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', FOCUS_RING);
/** A quiet text action under a card (Duplicate, Delete): muted, ink on hover, 44 px on touch. */
const CARD_FOOT_ACTION = `inline-flex min-h-8 items-center gap-1 ${RADIUS_CONTROL} px-1 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] ${FOCUS_RING} coarse:min-h-[var(--ds-density-touch)]`;

/** Creation failures from the studio API carry user-safe messages; anything else gets ours. */
const friendlyCreateError = (err: unknown): string => {
  const e = (err && typeof err === 'object' ? err : {}) as { kind?: unknown; message?: unknown };
  if (typeof e.kind === 'string' && typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  return "Couldn't create your comic. Check your connection and try again.";
};

/**
 * Keep a v4 comic's title in its studio document. The doc is the source of truth — the
 * server re-mirrors projects.name from it on every save — so renaming only the listing
 * row would be undone the next time the studio saves. Resolves to an error message (or
 * null) instead of throwing: the dashboard rename has already happened locally.
 */
export const syncStudioTitle = async (projectId: string, title: string): Promise<string | null> => {
  let failure: string | null = null;
  try {
    await streamStudio(
      projectId,
      { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title } }] } },
      (event) => {
        if (event.type === 'error') failure = event.message;
      }
    );
  } catch (err) {
    failure = err instanceof Error && err.message ? err.message : 'the studio did not respond';
  }
  return failure;
};

/** Inline title editor: Enter/blur saves, Escape cancels. Commits at most once. */
const TitleRenameInput: React.FC<{ initial: string; onDone: (value: string | null) => void }> = ({ initial, onDone }) => {
  const [draft, setDraft] = useState(initial);
  const doneRef = useRef(false);
  const finish = (value: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      aria-label="Comic title"
      value={draft}
      maxLength={PROJECT_NAME_MAX}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(draft);
        else if (e.key === 'Escape') finish(null);
      }}
      className={cn(INPUT_CLASSES, 'h-9 flex-1 px-2 text-[length:var(--ds-text-lg)] font-semibold')}
    />
  );
};

interface ProjectDashboardProps {
  projects: Project[];
  projectsLoaded?: boolean;
  /** One-shot navigation intent: show the existing creation form without creating a draft. */
  openNewComic?: boolean;
  onNewComicOpened?: () => void;
  /** The comics host's focused entry. Main-suite and classic dashboards retain their existing UI. */
  comicWorkspace?: boolean;
  accountId?: string;
  /** May return a promise: the dashboard shows progress and an inline error if it rejects. */
  onCreateProject: (name: string, mode: NewComicMode, initialIdea?: string) => void | Promise<void>;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onDuplicateProject: (id: string) => void;
  onReadProject: (id: string) => void;
  onUpdateProject: (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  onNavigate?: (view: string, id?: string) => void;
}



export const ProjectDashboard: React.FC<ProjectDashboardProps> = ({
  projects, projectsLoaded = true, openNewComic = false, onNewComicOpened, comicWorkspace = false, accountId, onCreateProject, onOpenProject, onDeleteProject, onDuplicateProject, onReadProject, onUpdateProject, onNavigate
}) => {
  const [isCreating, setIsCreating] = useState(openNewComic || (comicWorkspace && projectsLoaded && !projects.length));
  const ff = useFormFactor();
  const initialEntryChosen = useRef(openNewComic || projectsLoaded);
  const [classicForm, setClassicForm] = useState(false);
  useEffect(() => {
    if (initialEntryChosen.current || !projectsLoaded) return;
    initialEntryChosen.current = true;
    if (comicWorkspace && !projects.length) setIsCreating(true);
  }, [projectsLoaded, comicWorkspace, projects.length]);
  useEffect(() => {
    if (!openNewComic) return;
    initialEntryChosen.current = true;
    setIsCreating(true);
    setClassicForm(false);
    onNewComicOpened?.();
  }, [openNewComic, onNewComicOpened]);
  const draft = useComicIdeaDraft(comicWorkspace ? accountId : undefined);
  const { name: newProjectName, setName: setNewProjectName } = draft;
  const [createPending, setCreatePending] = useState<NewComicMode | null>(null);
  // Synchronous guard: Enter + click in the same tick must not create two comics.
  const createInFlightRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const beginNewComic = () => { initialEntryChosen.current = true; setClassicForm(false); setIsCreating(true); };
  const formMode = comicWorkspace && classicForm ? 'classic' : 'studio';
  // The frame's brand opens the member's own comics, never the visitor landing ('home' keeps meaning the landing):
  // All comics when there are comics, the idea form when there are none. While the list is still loading it shows the
  // loading state and lets the first-entry rule above choose once the list arrives. Ignored while a create runs (the
  // frame's other links are disabled then too).
  const showMyComics = () => {
    if (createInFlightRef.current) return;
    setClassicForm(false);
    setCreateError(null);
    if (!projectsLoaded) {
      initialEntryChosen.current = false;
      setIsCreating(false);
      return;
    }
    initialEntryChosen.current = true;
    setIsCreating(projects.length === 0);
  };
  // The Continue comic is chosen once per list load, not on every change to `projects`: updateProject stamps updatedAt
  // on any change (a rename, the Featured star), so ranking live would move an old comic into the card on that click.
  // The card shows the chosen comic's live row (a rename shows); a new choice is made when a load finishes or when the
  // chosen comic is deleted. While a reload runs the last choice stays (adjusting state during render, no effect).
  const [continueChoice, setContinueChoice] = useState<{ id: string | null; loaded: boolean } | null>(null);
  if (comicWorkspace) {
    const choiceGone = !!continueChoice?.id && !projects.some((p) => p.id === continueChoice.id);
    if (projectsLoaded && (!continueChoice || !continueChoice.loaded || choiceGone)) {
      setContinueChoice({ id: pickContinue(projects, Date.now())?.id ?? null, loaded: true });
    } else if (!projectsLoaded && continueChoice?.loaded) {
      setContinueChoice({ id: continueChoice.id, loaded: false });
    }
  }
  const continueProject = comicWorkspace && continueChoice?.id ? projects.find((p) => p.id === continueChoice.id) ?? null : null;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [infoProjectId, setInfoProjectId] = useState<string | null>(null);
  const infoProject = infoProjectId ? projects.find((p) => p.id === infoProjectId) : undefined;
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState<'updated' | 'created' | 'az' | 'za'>('updated');
  const [filterFeatured, setFilterFeatured] = useState(false);
  const [filterRecent, setFilterRecent] = useState(false);
  const [dateRange, setDateRange] = useState<'all' | '7' | '30' | '90'>('all');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'generating' | 'completed' | 'draft'>('all');
  const [hasCoverFilter, setHasCoverFilter] = useState(false);
  const [hasCommentsFilter, setHasCommentsFilter] = useState(false);
  const [stepFilter, setStepFilter] = useState<'all' | 'script' | 'style' | 'world' | 'cover' | 'layout' | 'build' | 'done'>('all');

  const filteredProjects = useMemo(() => {
    const now = Date.now();
    const maxAgeDays = dateRange === 'all' ? null : Number(dateRange);
    const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const dateCutoff = maxAgeDays ? now - maxAgeDays * 24 * 60 * 60 * 1000 : null;

    const matchesStep = (project: Project) => {
      if (stepFilter === 'all') return true;
      // Wizard steps are a classic-editor concept; studio comics have no step.
      if (isStudioV4Project(project)) return false;
      const step = project.state.step;
      switch (stepFilter) {
        case 'script': return step === AppStep.SCRIPT_INPUT;
        case 'style': return step === AppStep.STYLE_SELECTION;
        case 'world': return step === AppStep.REFERENCE_BUILDER;
        case 'cover': return step === AppStep.COVER;
        case 'layout': return step === AppStep.LAYOUT_SELECTION;
        case 'build': return step === AppStep.FULL_GENERATION;
        case 'done': return step === AppStep.REVIEW_EXPORT;
        default: return true;
      }
    };

	    const matchesStatus = (project: Project) => {
	      if (statusFilter === 'all') return true;
	      const studioProgress = studioPageProgress(project);
	      if (studioProgress) {
	        // Studio comics: done when every planned page is drawn; renders run server-side.
	        const done = studioProgress.pages > 0 && studioProgress.rendered >= studioProgress.pages;
	        if (statusFilter === 'completed') return done;
	        if (statusFilter === 'draft') return !done;
	        return false;
	      }
	      const isGenerating = !!project.state.generationStatus?.isActive;
	      const hasRenderedPageStudioPage = !!project.state.pageStudio?.pages?.some((page) => !!page.imageUrl);
	      const isCompleted = (project.state.panels.length > 0 || hasRenderedPageStudioPage) && !isGenerating;
	      const isDraft = project.state.panels.length === 0 && !hasRenderedPageStudioPage && !isGenerating;
      if (statusFilter === 'generating') return isGenerating;
      if (statusFilter === 'completed') return isCompleted;
      if (statusFilter === 'draft') return isDraft;
      return true;
    };

    return projects
      .filter((project) => {
        const search = searchTerm.trim().toLowerCase();
        const matchesSearch =
          !search ||
          project.name.toLowerCase().includes(search) ||
          (project.state.overview || '').toLowerCase().includes(search);

        const matchesFeatured = !filterFeatured || !!project.state.isFeatured;
        const matchesRecent = !filterRecent || project.updatedAt >= recentCutoff;
        const matchesDateRange = !dateCutoff || project.updatedAt >= dateCutoff;
        const matchesCover = !hasCoverFilter || !!project.state.coverImageUrl || !!project.state.coverImageId;
        const matchesComments = !hasCommentsFilter || (project.state.comments?.length || 0) > 0;

        return (
          matchesSearch &&
          matchesFeatured &&
          matchesRecent &&
          matchesDateRange &&
          matchesStatus(project) &&
          matchesCover &&
          matchesComments &&
          matchesStep(project)
        );
      })
      .sort((a, b) => {
        if (sortOption === 'updated') return b.updatedAt - a.updatedAt;
        if (sortOption === 'created') return b.createdAt - a.createdAt;
        if (sortOption === 'az') return a.name.localeCompare(b.name);
        if (sortOption === 'za') return b.name.localeCompare(a.name);
        return 0;
      });
  }, [projects, searchTerm, filterFeatured, filterRecent, dateRange, sortOption, statusFilter, hasCoverFilter, hasCommentsFilter, stepFilter]);

  const [visibleCount, setVisibleCount] = useState(12);

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(12);
  }, [searchTerm, filterFeatured, filterRecent, dateRange, sortOption, statusFilter, hasCoverFilter, hasCommentsFilter, stepFilter]);

  const displayedProjects = filteredProjects.slice(0, visibleCount);
  const hasMore = visibleCount < filteredProjects.length;

  // The studio asks for a title as before but doesn't require one ("Untitled comic" until
  // the user or the director names it). Creating talks to the server, so the form stays
  // open with a spinner and shows the failure inline (offline, expired session…).
  const handleCreate = async (mode: NewComicMode = 'studio') => {
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setCreateError(null);
    setCreatePending(mode);
    try {
      await onCreateProject(newProjectName.trim().slice(0, PROJECT_NAME_MAX), mode);
      setNewProjectName('');
      setIsCreating(false);
    } catch (err) {
      setCreateError(friendlyCreateError(err));
    } finally {
      createInFlightRef.current = false;
      setCreatePending(null);
    }
  };

  const startIdea = async (blank = false) => {
    if (createInFlightRef.current || (!blank && !draft.idea.trim())) return;
    createInFlightRef.current = true;
    setCreateError(null);
    setCreatePending('studio');
    try {
      await onCreateProject(newProjectName.trim().slice(0, PROJECT_NAME_MAX), 'studio', blank ? undefined : draft.idea);
      // Start blank leaves an unfinished idea available when the author returns.
      if (!blank) draft.clear();
      setIsCreating(false);
    } catch (err) {
      setCreateError(friendlyCreateError(err));
    } finally {
      createInFlightRef.current = false;
      setCreatePending(null);
    }
  };

  const commitRename = (project: Project, value: string | null) => {
    setRenamingId(null);
    if (value === null) return;
    const name = value.replace(/\s+/g, ' ').trim().slice(0, PROJECT_NAME_MAX);
    if (!name || name === project.name) return;
    onUpdateProject(project.id, { name });
    if (isStudioV4Project(project)) {
      void syncStudioTitle(project.id, name).then((failure) => {
        if (!failure) return;
        console.warn('[dashboard] studio title sync failed', failure);
        setNotice(`Renamed "${name}" here, but the studio couldn't save it (${failure}). Rename it inside the studio to keep the new title.`);
      });
    }
  };

  const renderLanding = () => (
    <div className={cn('text-center py-20 space-y-8', RISE_IN)}>
      <div className="space-y-3 max-w-2xl mx-auto">
        <h1 className={cn(TEXT_3XL, HEADING)}>No comics yet</h1>
        <p className="text-[length:var(--ds-text-lg)] leading-7 text-[var(--ds-muted)]">Describe your idea and the studio plans, draws and letters it with you.</p>
      </div>
      <div className="flex justify-center gap-6">
        <Button size="lg" onClick={beginNewComic}><Sparkles aria-hidden /> Create a new comic</Button>
      </div>

    </div>
  );

  const dashboard = (
    <div className={cn('max-w-7xl mx-auto p-4 medium:p-8', RISE_IN)}>
      <DataRescue />
      {/* Comic Studio members draw on the platform allowance: no setup checklist there (below, under the page's h1: the
          comic to continue and a line when their own key, if they added one, is over its limit). The main dashboard
          keeps the checklist. */}
      {!comicWorkspace && <ReadinessChecklist onNavigate={(v) => onNavigate?.(v)} />}
      {projects.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <div className="min-w-0">
              <h1 className={cn(TEXT_3XL, HEADING)}>My comics</h1>
              <p className="mt-1 text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">Manage your studio projects</p>
            </div>
            {/* One New comic per screen: the open form owns Create; in the comics workspace the frame's sidebar owns it,
                and only where that sidebar folds into a drawer does the header keep a quiet outline one. */}
            {!isCreating && (!comicWorkspace || ff.width < WORKSPACE_NAV_DRAWER_BELOW) && (
              <div className="flex items-center gap-4">
                <Button variant={comicWorkspace ? 'outline' : 'default'} onClick={beginNewComic}><Plus aria-hidden /> New comic</Button>
              </div>
            )}
          </div>

        </>
      )}

      {/* After the h1 so the page outline starts at "My comics"; still above the filters and the grid. */}
      {comicWorkspace && (
        <>
          {continueProject && !isCreating && <ContinueCard project={continueProject} onOpen={onOpenProject} onRead={onReadProject} />}
          <OwnKeyLimitLine onManageKeys={() => onNavigate?.('settings', 'settings')} />
        </>
      )}

      {notice && (
        <div role="status" className={cn('mb-6 flex items-start gap-2 border px-4 py-3 text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-ink)]', STATUS_SURFACE.attention, RADIUS_PANEL)}>
          <AlertTriangle className={cn('mt-1 h-4 w-4 shrink-0', STATUS_INK.attention)} aria-hidden />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice}</span>
          <IconButton label="Dismiss" size="sm" className="-my-1" onClick={() => setNotice(null)}>
            <X />
          </IconButton>
        </div>
      )}

      {isCreating && (
        <div className={cn('mb-12 mx-auto max-w-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6 text-[var(--ds-ink)]', RADIUS_PANEL, SHADOW_SOFT)}>
          <label htmlFor="new-comic-title" className={cn(FIELD_LABEL, 'mb-2 block')}>Comic Title</label>
          <Input
            id="new-comic-title"
            autoFocus
            type="text"
            value={newProjectName}
            maxLength={PROJECT_NAME_MAX}
            disabled={!!createPending}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="The Amazing Adventures of..."
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate(formMode)}
          />

          <div className={cn('mt-5 border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-4', RADIUS_CONTROL)}>
            <div className="flex items-center gap-2 text-[length:var(--ds-text-base)] font-semibold leading-5 text-[var(--ds-ink)]"><MessageSquare className="w-4 h-4 shrink-0" aria-hidden /> {formMode === 'classic' ? 'Classic editor' : 'Comic Studio'}</div>
            <p className="mt-1 text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]">
              {formMode === 'classic' ? 'Open the step-by-step editor to add your script, choose a style and build your pages.' : 'Talk through your idea — the studio plans pages, keeps characters consistent, and letters every balloon. You see the page plan and the cost before anything is drawn.'}
            </p>
          </div>

          {createError && (
            <div role="alert" className={cn('mt-4 flex items-start gap-2 border px-3 py-2 text-[length:var(--ds-text-base)] font-medium leading-6', STATUS_SURFACE.error, STATUS_INK.error, RADIUS_CONTROL)}>
              <AlertTriangle className="mt-1 h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0">{createError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-5">
            <Button onClick={() => void handleCreate(formMode)} loading={createPending === formMode} disabled={!!createPending}>
              {createPending === formMode ? 'Creating…' : 'Create'}
            </Button>
            <Button variant="outline" onClick={() => { if (comicWorkspace && classicForm) setClassicForm(false); else setIsCreating(false); setCreateError(null); }} disabled={!!createPending}>Cancel</Button>
            {formMode !== 'classic' && <button
              type="button"
              onClick={() => void handleCreate('classic')}
              disabled={!!createPending}
              className={cn('ml-auto inline-flex min-h-8 items-center px-1 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)] underline-offset-2 hover:text-[var(--ds-ink)] hover:underline disabled:opacity-50 coarse:min-h-[var(--ds-density-touch)]', RADIUS_CONTROL, FOCUS_RING)}
            >
              Use the classic editor instead
            </button>}
          </div>
        </div>
      )}

      {projects.length === 0 ? (!projectsLoaded ? <LoadingState title="Loading your comics…" /> : renderLanding()) : (
        <>
          <div className={cn('mb-6 border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4', RADIUS_PANEL, SHADOW_SOFT)}>
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search projects..."
                aria-label="Search projects"
                className="lg:flex-1"
              />
              {/* Below sm the controls sit on a two-column grid so the row reads aligned, not ragged */}
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                <button
                  type="button"
                  aria-pressed={filterFeatured}
                  onClick={() => setFilterFeatured((prev) => !prev)}
                  className={cn(filterToggle(filterFeatured), 'justify-center')}
                >
                  <Star className="w-4 h-4" aria-hidden /> Featured
                </button>
                <button
                  type="button"
                  aria-pressed={filterRecent}
                  onClick={() => setFilterRecent((prev) => !prev)}
                  className={cn(filterToggle(filterRecent), 'justify-center')}
                >
                  <Clock className="w-4 h-4" aria-hidden /> Recent Changes
                </button>
                <Select
                  size="sm"
                  aria-label="Date range"
                  wrapperClassName="w-full sm:w-auto"
                  value={dateRange}
                  onChange={(e) => setDateRange(e.target.value as any)}
                >
                  <option value="all">All Dates</option>
                  <option value="7">Last 7 Days</option>
                  <option value="30">Last 30 Days</option>
                  <option value="90">Last 90 Days</option>
                </Select>
                <Select
                  size="sm"
                  aria-label="Sort by"
                  wrapperClassName="w-full sm:w-auto"
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value as any)}
                >
                  <option value="updated">Recent Updated</option>
                  <option value="created">Recent Created</option>
                  <option value="az">A–Z</option>
                  <option value="za">Z–A</option>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((prev) => !prev)}
                  className="col-span-2"
                >
                  <Filter aria-hidden /> More Filters
                </Button>
              </div>
            </div>
            {advancedOpen && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                <Select
                  size="sm"
                  aria-label="Status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                >
                  <option value="all">All Statuses</option>
                  <option value="generating">Generating</option>
                  <option value="completed">Completed</option>
                  <option value="draft">Draft</option>
                </Select>
                <Select
                  size="sm"
                  aria-label="Step"
                  value={stepFilter}
                  onChange={(e) => setStepFilter(e.target.value as any)}
                >
                  <option value="all">All Steps</option>
                  <option value="script">Script</option>
                  <option value="style">Style</option>
                  <option value="world">World</option>
                  <option value="cover">Cover</option>
                  <option value="layout">Layout</option>
                  <option value="build">Build</option>
                  <option value="done">Done</option>
                </Select>
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-pressed={hasCoverFilter}
                    onClick={() => setHasCoverFilter((prev) => !prev)}
                    className={cn(filterToggle(hasCoverFilter), 'flex-1 justify-center')}
                  >
                    Has Cover
                  </button>
                  <button
                    type="button"
                    aria-pressed={hasCommentsFilter}
                    onClick={() => setHasCommentsFilter((prev) => !prev)}
                    className={cn(filterToggle(hasCommentsFilter), 'flex-1 justify-center')}
                  >
                    Has Comments
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearchTerm('');
                    setSortOption('updated');
                    setFilterFeatured(false);
                    setFilterRecent(false);
                    setDateRange('all');
                    setStatusFilter('all');
                    setHasCoverFilter(false);
                    setHasCommentsFilter(false);
                    setStepFilter('all');
                  }}
                >
                  Reset Filters
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-8">
            {filteredProjects.length === 0 && (
              <div className="col-span-full text-center text-[length:var(--ds-text-lg)] text-[var(--ds-muted)]">
                No projects match the current filters.
              </div>
            )}
	            {displayedProjects.map(project => {
	              const firstPageStudioImage = project.state.pageStudio?.pages?.find((page) => page.imageUrl)?.imageUrl;
	              // One candidate order for the grid and the Continue card (homeModel).
	              const previewCandidates = coverCandidates(project);
	              const primaryPreview = previewCandidates[0];
	              const fallbackPreviews = previewCandidates.slice(1);
	              const hasPanelPreview = project.state.panels.some((panel) => panel.imageUrl);
	              const hasPageStudioPreview = Boolean(firstPageStudioImage);
	              const hasStylePreview = project.state.styleVariants.some((variant) => variant.imageUrl);
	              const hasCoverPreview = Boolean(project.state.coverImageUrl);
	              // Comic Studio v4 comics: cover/page-1 thumbnail from the mirrored coverImageId,
	              // a Studio badge and "N of M pages" progress. Their content lives server-side.
	              const isStudio = isStudioV4Project(project);
	              const studioProgress = studioPageProgress(project);

              return (
                <div key={project.id} className={cn('group flex flex-col overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-ink)]', RADIUS_PANEL, SHADOW_SOFT, LIFT)}>
                  <div className="aspect-video bg-[var(--ds-well-strong)] border-b border-[var(--ds-hairline)] relative overflow-hidden">
                    {primaryPreview ? (
                      <SmartImage
                        src={primaryPreview}
                        fallbackSources={fallbackPreviews}
                        alt={`${project.name} cover`}
	                        className={`w-full h-full object-cover ${isStudio ? 'object-top' : ''} ${!hasCoverPreview && !hasPanelPreview && !hasPageStudioPreview && !hasStylePreview ? 'opacity-50 grayscale' : ''}`}
                        loadingComponent={<LoadingState variant="inline" title="Loading cover…" className="h-full w-full justify-center bg-[var(--ds-canvas)]" />}
                        fallbackIcon={<BookOpen className="size-8 text-[var(--ds-muted)]" aria-hidden />}
                        containerClassName="w-full h-full"
                      />
                    ) : isStudio ? (
                      <div className={`w-full h-full flex flex-col items-center justify-center gap-1 bg-[var(--ds-well)] text-[var(--ds-muted)] ${CARD_COVER_TOUCH}`}>
                        <MessageSquare className="h-9 w-9" aria-hidden />
                        <span className="text-[length:var(--ds-text-sm)] font-medium">Nothing drawn yet</span>
                      </div>
                    ) : (
                      <div className={`w-full h-full flex items-center justify-center bg-[var(--ds-well)] text-[var(--ds-muted)] ${CARD_COVER_TOUCH}`} role="img" aria-label="No cover yet"><BookOpen className="size-9" aria-hidden /></div>
                    )}

                    {isStudio && (
                      <span
                        data-testid="studio-badge"
                        title="Made in the conversational Comic Studio"
                        className={cn(CHIP, 'absolute left-2 top-2 border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)]')}
                      >
                        <Sparkles className="h-3 w-3" aria-hidden /> Studio
                      </span>
                    )}

                    {project.state.generationStatus?.isActive && (
                      <div className={`absolute inset-0 ${INVERSE_SURFACE} flex flex-col items-center justify-center p-4 ${CARD_COVER_TOUCH}`}>
                        <div className="mb-2 text-[length:var(--ds-text-xl)] font-semibold leading-7 animate-pulse motion-reduce:animate-none">Generating...</div>
                        <div className={`w-full h-2 mb-2 overflow-hidden rounded-[var(--ds-radius-pill)] bg-[color:color-mix(in_srgb,var(--ds-canvas)_20%,transparent)] ${CARD_BAR_TOUCH}`}>
                          <div className="h-full bg-[var(--ds-canvas)] transition-[width] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-reduce:transition-none" style={{ width: `${project.state.generationStatus.progress}%` }} />
                        </div>
                        <div className="text-[length:var(--ds-text-sm)] tabular-nums text-[color:color-mix(in_srgb,var(--ds-canvas)_75%,transparent)]">Est: {project.state.generationStatus.estimatedTimeRemaining}</div>
                      </div>
                    )}

                    <div className={`absolute inset-0 ${SCRIM} flex items-center justify-center opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100 transition-opacity gap-2 ${CARD_ACTIONS_TOUCH}`}>
                      <Button size="sm" className={CARD_ACTION_TOUCH} onClick={() => onReadProject(project.id)}><BookOpen aria-hidden />Read</Button>
                      <Button size="sm" variant="secondary" className={CARD_ACTION_TOUCH} onClick={() => onOpenProject(project.id)}><Edit aria-hidden />{isStudio ? 'Open' : 'Edit'}</Button>
                      <Button size="sm" variant="outline" className={CARD_ACTION_TOUCH} onClick={() => setInfoProjectId(project.id)}><Info aria-hidden />Info</Button>
                    </div>
                  </div>
                  <div className="p-5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      {renamingId === project.id ? (
                        <TitleRenameInput initial={project.name} onDone={(value) => commitRename(project, value)} />
                      ) : (
                        <div className="group/title flex min-w-0 items-center gap-1">
                          <h3 className="truncate text-[length:var(--ds-text-lg)] font-semibold leading-6 tracking-[-0.01em]">{project.name}</h3>
                          <IconButton
                            size="sm"
                            label={`Rename ${project.name}`}
                            title="Rename"
                            className="text-[var(--ds-muted)] hover:text-[var(--ds-ink)]"
                            onClick={() => setRenamingId(project.id)}
                          >
                            <Pencil />
                          </IconButton>
                        </div>
                      )}
                      <IconButton
                        onClick={() => onUpdateProject(project.id, (prev) => ({
                          state: { ...prev.state, isFeatured: !prev.state.isFeatured }
                        }))}
                        className={project.state.isFeatured ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'}
                        title="Toggle Featured"
                        label={project.state.isFeatured ? "Unmark as featured" : "Mark as featured"}
                      >
                        <Star className={cn(project.state.isFeatured && 'fill-current')} />
                      </IconButton>
                    </div>
                    <div className="flex justify-between items-center mb-4">
                      <p className="text-[length:var(--ds-text-sm)] tabular-nums text-[var(--ds-muted)]">Updated: {new Date(project.updatedAt).toLocaleDateString()}</p>
                      {project.state.generationStatus?.isActive && <Badge variant="secondary">BUILDING</Badge>}
                    </div>

                    {studioProgress && (
                      <div className="-mt-2 mb-4" data-testid="studio-progress">
                        <div className="flex items-center justify-between gap-2 text-[length:var(--ds-text-sm)] font-medium text-[var(--ds-muted)]">
                          <span>{formatStudioProgress(studioProgress)}</span>
                          {studioProgress.pages > 0 && studioProgress.rendered >= studioProgress.pages && (
                            <span className={cn('inline-flex items-center gap-1', STATUS_INK.healthy)}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Drawn</span>
                          )}
                        </div>
                        {studioProgress.pages > 0 && (
                          <div
                            className="mt-1 h-1.5 overflow-hidden rounded-[var(--ds-radius-pill)] bg-[var(--ds-well-strong)]"
                            role="progressbar"
                            aria-label="Pages drawn"
                            aria-valuemin={0}
                            aria-valuemax={studioProgress.pages}
                            aria-valuenow={studioProgress.rendered}
                          >
                            <div className="h-full bg-[var(--ds-ink)] transition-[width] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-reduce:transition-none" style={{ width: `${(studioProgress.rendered / studioProgress.pages) * 100}%` }} />
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex justify-between border-t border-[var(--ds-hairline)] pt-3">
                      {isStudio ? (
                        // A studio comic's content lives server-side (comic_docs); copying the
                        // listing row would make a comic with no document — so not yet.
                        <span title={DUPLICATE_UNAVAILABLE_FOR_STUDIO}>
                          <button
                            disabled
                            aria-disabled="true"
                            aria-label={DUPLICATE_UNAVAILABLE_FOR_STUDIO}
                            className={cn(CARD_FOOT_ACTION, 'cursor-not-allowed opacity-50')}
                          >
                            <Copy size={14} aria-hidden /> Duplicate
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => onDuplicateProject(project.id)} className={cn(CARD_FOOT_ACTION, 'hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]')}>
                          <Copy size={14} aria-hidden /> Duplicate
                        </button>
                      )}
                      <button
                        onClick={() => {
                          let confirmed = true;
                          try {
                            confirmed = window.confirm(`Delete "${project.name}"? This can't be undone.`);
                          } catch {
                            /* confirm unavailable (embedded webviews) — proceed as before */
                          }
                          if (confirmed) onDeleteProject(project.id);
                        }}
                        className={cn(CARD_FOOT_ACTION, 'hover:bg-[var(--ds-hover)] hover:text-[var(--ds-danger-text)]')}
                      >
                        <Trash2 size={14} aria-hidden /> Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {hasMore && (
            <div className="flex justify-center mb-12">
              <Button
                variant="outline"
                onClick={() => setVisibleCount(prev => prev + 12)}
                className="w-full max-w-xs"
              >
                Load More Projects
              </Button>
            </div>
          )}
        </>
      )}
      {infoProject && (
        <Suspense fallback={<div className={cn('fixed inset-0 flex items-center justify-center', SCRIM, Z.dialog)}><div className={cn(OVERLAY, 'p-4')}><Loader2 className="animate-spin motion-reduce:animate-none w-8 h-8" aria-hidden /></div></div>}>
          <ProjectInfoModal
            project={infoProject}
            onClose={() => setInfoProjectId(null)}
            onUpdateProject={onUpdateProject}
          />
        </Suspense>
      )}
    </div>
  );
  // The apex dashboard paints its own canvas and ink across the full width, so the page reads in both themes.
  if (!comicWorkspace) return <div className={cn('min-h-full text-[var(--ds-ink)]', CANVAS_BG)}>{dashboard}</div>;
  return <ComicWorkspaceFrame title={isCreating ? (classicForm ? 'Classic editor' : 'New comic') : 'All comics'}
    onHome={showMyComics} onAccount={() => onNavigate?.('settings')}
    navigation={{ projects, activeView: isCreating ? 'new' : 'all', disabled: !!createPending,
      onNewComic: beginNewComic,
      onAllComics: () => { initialEntryChosen.current = true; setIsCreating(false); setCreateError(null); },
      onLibrary: () => onNavigate?.('gallery'), onOpenProject }}>
    {isCreating && !classicForm ? <ComicIdeaForm name={newProjectName} idea={draft.idea} pending={!!createPending} error={createError}
      onName={setNewProjectName} onIdea={draft.setIdea} onStart={() => void startIdea()} onStartBlank={() => void startIdea(true)}
      onClassic={() => setClassicForm(true)} onLibrary={() => onNavigate?.('gallery')} /> : dashboard}
  </ComicWorkspaceFrame>;
};

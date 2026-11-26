import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { Plus, AlertTriangle, Star, Filter, Clock, Loader2, MessageSquare, X } from 'lucide-react';
import { AppStep, Project } from '../types';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, EmptyState, IconButton, Input, Select, announce } from './ds';
import { FIELD_LABEL } from './ds/Field';
import { FILTER_CHIP, FILTER_CHIP_ON } from './ds/FilterChips';
import {
  FOCUS_RING,
  HEADING,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RISE_IN,
  CANVAS_BG,
  SCRIM,
  SHADOW_SOFT,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_3XL,
  OVERLAY,
  Z
} from './chat/studioDesign';
import { cn } from '../lib/utils';
// Lazy load ProjectInfoModal
const ProjectInfoModal = React.lazy(() => import('./modals/ProjectInfoModal').then(module => ({ default: module.ProjectInfoModal })));
import { DataRescue } from './DataRescue';
import { ReadinessChecklist } from './ReadinessChecklist';
import { LoadingState } from './ds/LoadingState';
import { streamStudio } from './comicstudio/studioApi';
import { isStudioV4Project, studioPageProgress } from '../services/studioDeepLink';
import { ComicIdeaForm, ComicWorkspaceFrame, WORKSPACE_NAV_DRAWER_BELOW } from './comicstudio/ComicCreationWorkspace';
import { useFormFactor } from './comicstudio/mobile/useFormFactor';
import { useComicIdeaDraft } from './comicstudio/comicIdeaDraft';
import { ContinueCard } from './comicstudio/home/ContinueCard';
import { OwnKeyLimitLine } from './comicstudio/home/OwnKeyLimitLine';
import { MyComicCard, MyComicCardPlaceholder, type MyComicCardActions } from './comicstudio/home/MyComicCard';
import { MyComicsEmpty } from './comicstudio/home/MyComicsEmpty';
import { useComicStages } from './comicstudio/home/useComicStages';
import { requestTaskTarget, type TaskDestination } from './comicstudio/home/workspaceTaskTarget';
import {
  matchesStageFilter,
  myComicCard,
  orderMyComics,
  pickContinue,
  PROJECT_NAME_MAX,
  STAGE_FILTERS,
  type CardStageRow,
  type CardStageStatus,
  type MyComicCardModel,
  type MyComicsSort,
  type StageFilter
} from './comicstudio/home/homeModel';
import { STAGE_LABEL } from '../shared/comic/stage';

export { DUPLICATE_UNAVAILABLE_FOR_STUDIO } from './comicstudio/home/MyComicCard';

/** How a new comic starts: the conversational Comic Studio (default) or a classic pipeline. */
export type NewComicMode = 'studio' | 'classic' | 'pagestudio';

/** Cards shown at first, and added by each "Show more comics". */
const PAGE_SIZE = 24;
/** The first cards load their covers at once; the rest load as they come near. */
const PRIORITY_COVERS = 3;
/**
 * Until a stage read has answered (this tab remembers the last one), the grid waits this long at most once it has cards
 * to show (skeleton cards in the same footprint), so a comic that needs the person is placed first from the start
 * instead of jumping there after paint.
 */
const STAGE_WAIT_MS = 1200;

/** A filter toggle in the search bar (Featured, Recent Changes, Has Cover, Has Comments): an outline chip, ink while on. */
const filterToggle = (on: boolean): string =>
  cn(FILTER_CHIP, on ? FILTER_CHIP_ON : 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', FOCUS_RING);

/** The Step filter: the studio's stages (from the saved summary) and the classic editor's steps. */
type StepFilter = 'all' | 'script' | 'style' | 'world' | 'cover' | 'layout' | 'build' | 'done' | `stage:${StageFilter}`;
const stageFilterOf = (step: StepFilter): StageFilter | null => (step.startsWith('stage:') ? (step.slice(6) as StageFilter) : null);

/** The grid: one column of row cards on a phone, then as many 17 rem cards as fit (the frame's sidebar may be open). */
const MY_COMICS_GRID = 'm-0 mb-8 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] sm:gap-4';

/**
 * Each card's words, kept per comic while its inputs are the same objects, so a star or a rename re-renders one card
 * (MyComicCard is memoised) and 150 cards stay smooth.
 */
function useCardModels(projects: readonly Project[], rows: ReadonlyMap<string, CardStageRow>, status: CardStageStatus, now: number) {
  const cache = useRef(new Map<string, { project: Project; row: CardStageRow | undefined; status: CardStageStatus; now: number; model: MyComicCardModel }>());
  return useMemo(() => {
    const next = new Map<string, MyComicCardModel>();
    const kept = new Map<string, { project: Project; row: CardStageRow | undefined; status: CardStageStatus; now: number; model: MyComicCardModel }>();
    for (const project of projects) {
      const row = rows.get(project.id);
      // The read's status only matters to a comic it has no row for yet (its placeholder): a read starting or ending
      // leaves every other card as it was.
      const own: CardStageStatus = row ? 'settled' : status;
      const hit = cache.current.get(project.id);
      const entry = hit && hit.project === project && hit.row === row && hit.status === own && hit.now === now ? hit : { project, row, status: own, now, model: myComicCard(project, row, own, now) };
      kept.set(project.id, entry);
      next.set(project.id, entry.model);
    }
    cache.current = kept;
    return next;
  }, [projects, rows, status, now]);
}

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

interface ProjectDashboardProps {
  projects: Project[];
  projectsLoaded?: boolean;
  /** One-shot navigation intent: show the existing creation form without creating a draft. */
  openNewComic?: boolean;
  initialLookBrief?: string;
  onNewComicOpened?: () => void;
  /** The comics host's focused entry. Main-suite and classic dashboards retain their existing UI. */
  comicWorkspace?: boolean;
  accountId?: string;
  /** May return a promise: the dashboard shows progress and an inline error if it rejects. */
  onCreateProject: (name: string, mode: NewComicMode, initialIdea?: string, directorCreationId?: string) => void | Promise<void>;
  onOpenProject: (id: string) => void;
  onOpenStudioWork?: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onDuplicateProject: (id: string) => void;
  onReadProject: (id: string) => void;
  onUpdateProject: (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  onNavigate?: (view: string, id?: string) => void;
}



export const ProjectDashboard: React.FC<ProjectDashboardProps> = ({
  projects, projectsLoaded = true, openNewComic = false, initialLookBrief, onNewComicOpened, comicWorkspace = false, accountId, onCreateProject, onOpenProject, onOpenStudioWork, onDeleteProject, onDuplicateProject, onReadProject, onUpdateProject, onNavigate
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
  const draft = useComicIdeaDraft(comicWorkspace ? accountId : undefined);
  const requestOpened = useRef(false);
  useEffect(() => {
    if (!openNewComic) { requestOpened.current = false; return; }
    if (requestOpened.current) return;
    requestOpened.current = true;
    if (initialLookBrief && !draft.idea.includes(initialLookBrief)) {
      draft.setIdea([draft.idea.trimEnd(), initialLookBrief].filter(Boolean).join('\n\n'));
    }
    initialEntryChosen.current = true;
    setIsCreating(true);
    setClassicForm(false);
    onNewComicOpened?.();
  }, [openNewComic, initialLookBrief, onNewComicOpened, draft.idea, draft.setIdea]);
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
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteTarget = deleteId ? projects.find((p) => p.id === deleteId) : undefined;
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState<MyComicsSort>('updated');
  const [filterFeatured, setFilterFeatured] = useState(false);
  const [filterRecent, setFilterRecent] = useState(false);
  const [dateRange, setDateRange] = useState<'all' | '7' | '30' | '90'>('all');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'generating' | 'completed' | 'draft'>('all');
  const [hasCoverFilter, setHasCoverFilter] = useState(false);
  const [hasCommentsFilter, setHasCommentsFilter] = useState(false);
  const [stepFilter, setStepFilter] = useState<StepFilter>('all');

  // Every card's stage and "Needs you" come from ONE read of the saved summaries (never a full comic, never a request
  // per card), made when the view opens and again when the list reloads; nothing refreshes on a timer.
  const stages = useComicStages(accountId, projectsLoaded);
  const hasStudioComics = useMemo(() => projects.some((p) => isStudioV4Project(p)), [projects]);
  const [stageWaitOver, setStageWaitOver] = useState(false);
  const waitingForStages = stages.status === 'loading' && !stages.known;
  // Counted from when there are cards to show, whether the list is still reloading or not (back from the studio, the
  // cards already in memory are on screen while it reloads).
  const hasCards = projects.length > 0;
  useEffect(() => {
    if (!waitingForStages || !hasCards) return;
    const timer = window.setTimeout(() => setStageWaitOver(true), STAGE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waitingForStages, hasCards]);
  const holdGrid = hasStudioComics && waitingForStages && !stageWaitOver;
  // The relative times ("edited 2 hours ago") are read once per list load and stage read, so a card's words only change
  // when its comic does.
  const now = useMemo(() => Date.now(), [projectsLoaded, stages.rows]);
  const models = useCardModels(projects, stages.rows, stages.status, now);

  const filteredProjects = useMemo(() => {
    const now = Date.now();
    const maxAgeDays = dateRange === 'all' ? null : Number(dateRange);
    const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const dateCutoff = maxAgeDays ? now - maxAgeDays * 24 * 60 * 60 * 1000 : null;

    const matchesStep = (project: Project) => {
      if (stepFilter === 'all') return true;
      // A studio stage reads the saved summary; a comic without one matches no stage (never a guess).
      const stage = stageFilterOf(stepFilter);
      if (stage) return isStudioV4Project(project) && matchesStageFilter(stages.rows.get(project.id)?.stage, stage);
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

    const matched = projects.filter((project) => {
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
    });
    // The default order puts every comic that waits on the person first ("Needs you"), then the most recently edited.
    return orderMyComics(matched, sortOption, (project) => !!models.get(project.id)?.needsYou);
  }, [projects, searchTerm, filterFeatured, filterRecent, dateRange, sortOption, statusFilter, hasCoverFilter, hasCommentsFilter, stepFilter, stages.rows, models]);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchTerm, filterFeatured, filterRecent, dateRange, sortOption, statusFilter, hasCoverFilter, hasCommentsFilter, stepFilter]);

  const displayedProjects = filteredProjects.slice(0, visibleCount);
  const hasMore = visibleCount < filteredProjects.length;
  const resetFilters = () => {
    setSearchTerm('');
    setSortOption('updated');
    setFilterFeatured(false);
    setFilterRecent(false);
    setDateRange('all');
    setStatusFilter('all');
    setHasCoverFilter(false);
    setHasCommentsFilter(false);
    setStepFilter('all');
  };

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

  const startIdea = async (intent: 'hands-on' | 'director' | 'blank' = 'hands-on') => {
    const blank = intent === 'blank';
    if (createInFlightRef.current || (!blank && !draft.idea.trim())) return;
    createInFlightRef.current = true;
    setCreateError(null);
    setCreatePending('studio');
    try {
      const title = newProjectName.trim().slice(0, PROJECT_NAME_MAX);
      if (intent === 'director') {
        await onCreateProject(title, 'studio', draft.idea, draft.directorCreationId());
      } else {
        await onCreateProject(title, 'studio', blank ? undefined : draft.idea);
      }
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

  // One stable set of card handlers (every card is memoised): each reads the latest props and state through a ref.
  const latest = useRef({ projects, accountId, onOpenProject, onReadProject, onUpdateProject, onDuplicateProject, commitRename });
  latest.current = { projects, accountId, onOpenProject, onReadProject, onUpdateProject, onDuplicateProject, commitRename };
  const cardActions = useMemo<MyComicCardActions>(() => ({
    // The next step deep-links: the studio opens at that place (task target), and never starts anything on arrival.
    open: (id: string, destination: TaskDestination | null) => {
      const { accountId: owner, onOpenProject: openProject } = latest.current;
      if (destination && owner) requestTaskTarget(owner, id, destination);
      openProject(id);
    },
    read: (id: string) => latest.current.onReadProject(id),
    startRename: (id: string) => setRenamingId(id),
    finishRename: (id: string, value: string | null) => {
      const project = latest.current.projects.find((p) => p.id === id);
      if (project) latest.current.commitRename(project, value);
      else setRenamingId(null);
    },
    toggleFeatured: (id: string) => latest.current.onUpdateProject(id, (prev) => ({ state: { ...prev.state, isFeatured: !prev.state.isFeatured } })),
    details: (id: string) => setInfoProjectId(id),
    duplicate: (id: string) => latest.current.onDuplicateProject(id),
    askDelete: (id: string) => setDeleteId(id)
  }), []);
  const openContinue = (id: string, destination?: TaskDestination | null) => cardActions.open(id, destination ?? null);

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
              <p className="mt-1 text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]">Where each comic stands, and what’s next</p>
            </div>
            {/* One New comic per screen: the open form owns Create; in the comics workspace the frame's sidebar owns it,
                and only where that sidebar folds into a drawer does the header keep a quiet outline one. */}
            {!isCreating && (!comicWorkspace || ff.width < WORKSPACE_NAV_DRAWER_BELOW) && (
              <div className="flex flex-wrap items-center gap-2">
                {comicWorkspace && onNavigate && <Button variant="outline" onClick={() => onNavigate('images')}>Create an image</Button>}
                <Button variant={comicWorkspace ? 'outline' : 'default'} onClick={beginNewComic}><Plus aria-hidden /> New comic</Button>
              </div>
            )}
          </div>

        </>
      )}

      {/* After the h1 so the page outline starts at "My comics"; still above the filters and the grid. */}
      {comicWorkspace && (
        <>
          {continueProject && !isCreating && (
            <ContinueCard project={continueProject} stageRow={stages.rows.get(continueProject.id)} stageStatus={stages.status} now={now} onOpen={openContinue} onRead={onReadProject} />
          )}
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

      {/* No comics yet: the empty state, until its Create opens the form above (the form is then the one action). */}
      {projects.length === 0 ? (!projectsLoaded ? <LoadingState title="Loading your comics…" /> : isCreating ? null : <MyComicsEmpty onCreate={beginNewComic} />) : (
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
                  onChange={(e) => setSortOption(e.target.value as MyComicsSort)}
                >
                  <option value="updated">Needs you, then recent</option>
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
                  onChange={(e) => setStepFilter(e.target.value as StepFilter)}
                >
                  <option value="all">All Steps</option>
                  {/* The studio's stages read each comic's saved stage; a comic without one matches none of them. */}
                  <optgroup label="Studio stage">
                    {STAGE_FILTERS.map((stage) => (
                      <option key={stage} value={`stage:${stage}`}>{stage === 'published' ? 'Published' : STAGE_LABEL[stage]}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Classic editor step">
                    <option value="script">Script</option>
                    <option value="style">Style</option>
                    <option value="world">World</option>
                    <option value="cover">Cover</option>
                    <option value="layout">Layout</option>
                    <option value="build">Build</option>
                    <option value="done">Done</option>
                  </optgroup>
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
                <Button size="sm" variant="ghost" onClick={resetFilters}>
                  Reset Filters
                </Button>
              </div>
            )}
          </div>

          {filteredProjects.length === 0 ? (
            <EmptyState
              variant="inline"
              title="No comics match"
              description="Try another search, or clear the filters to see every comic."
              action={{ label: 'Reset filters', onClick: resetFilters }}
              className="mb-8"
            />
          ) : holdGrid ? (
            // The first stage read is on its way: cards of the same footprint, so the real ones arrive in their final order.
            <ul role="list" aria-label="Your comics, loading" aria-busy="true" className={MY_COMICS_GRID}>
              {displayedProjects.map((project) => (
                <li key={project.id} className="min-w-0">
                  <MyComicCardPlaceholder />
                </li>
              ))}
            </ul>
          ) : (
            <ul role="list" aria-label="Your comics" className={MY_COMICS_GRID}>
              {displayedProjects.map((project, index) => {
                const model = models.get(project.id);
                if (!model) return null;
                return (
                  <li key={project.id} className="min-w-0">
                    <MyComicCard project={project} model={model} renaming={renamingId === project.id} priority={index < PRIORITY_COVERS} actions={cardActions} />
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore && (
            <div className="flex justify-center mb-12">
              <Button
                variant="outline"
                data-show-more=""
                aria-label={`Show more comics, ${filteredProjects.length - visibleCount} more`}
                onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                className="w-full max-w-xs"
              >
                Show more comics
              </Button>
            </div>
          )}
        </>
      )}
      {deleteTarget && (
        <AlertDialog open onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleteTarget.name.trim() || 'Untitled comic'}”?</AlertDialogTitle>
              <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const name = deleteTarget.name.trim() || 'Untitled comic';
                  onDeleteProject(deleteTarget.id);
                  announce(`Deleted ${name}`);
                }}
              >
                Delete comic
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
    onHome={showMyComics}
    navigation={{ projects, projectsLoaded: projectsLoaded || projects.length > 0, accountId, onOpenStudioWork, activeView: isCreating ? 'new' : 'all', disabled: !!createPending,
      onNewComic: beginNewComic,
      onImages: onNavigate && (() => onNavigate('images')),
      onChat: onNavigate && (() => onNavigate('chat')),
      onAllComics: () => { initialEntryChosen.current = true; setIsCreating(false); setCreateError(null); },
      onLibrary: () => onNavigate?.('gallery'), onOpenProject }}>
    {isCreating && !classicForm ? <ComicIdeaForm name={newProjectName} idea={draft.idea} pending={!!createPending} error={createError}
      onName={setNewProjectName} onIdea={draft.setIdea} onStart={() => void startIdea()} onDraft={() => void startIdea('director')} onStartBlank={() => void startIdea('blank')}
      onImages={onNavigate && (() => onNavigate('images'))} onClassic={() => setClassicForm(true)} onLibrary={() => onNavigate?.('gallery')} /> : dashboard}
  </ComicWorkspaceFrame>;
};

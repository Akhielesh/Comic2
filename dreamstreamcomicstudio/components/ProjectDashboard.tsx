import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { Plus, BookOpen, Edit, Trash2, Copy, LayoutGrid, Sparkles, CheckCircle2, XCircle, AlertTriangle, Info, Star, Filter, Calendar, ArrowDownAZ, ArrowUpAZ, Clock, Loader2, MessageSquare, Pencil, X } from 'lucide-react';
import { AppStep, Project } from '../types';
import { Button } from './Button';
// Lazy load ProjectInfoModal
const ProjectInfoModal = React.lazy(() => import('./modals/ProjectInfoModal').then(module => ({ default: module.ProjectInfoModal })));
import { DataRescue } from './DataRescue';
import { ReadinessChecklist } from './ReadinessChecklist';
import { getFluxKeyInfo } from '../services/appSettings';
import { SmartImage } from './common/SmartImage';
import { streamStudio } from './comicstudio/studioApi';
import { formatStudioProgress, isStudioV4Project, studioPageProgress } from '../services/studioDeepLink';

/** How a new comic starts: the conversational Comic Studio (default) or a classic pipeline. */
export type NewComicMode = 'studio' | 'classic' | 'pagestudio';

/** Project names are capped server-side at 200 characters. */
const PROJECT_NAME_MAX = 200;

export const DUPLICATE_UNAVAILABLE_FOR_STUDIO = "Duplicate isn't available for studio comics yet";

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
      className="min-w-0 flex-1 border-2 border-black rounded-lg px-2 py-0.5 font-display text-xl outline-none focus:shadow-comic"
    />
  );
};

interface ProjectDashboardProps {
  projects: Project[];
  /** May return a promise: the dashboard shows progress and an inline error if it rejects. */
  onCreateProject: (name: string, mode: NewComicMode) => void | Promise<void>;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onDuplicateProject: (id: string) => void;
  onReadProject: (id: string) => void;
  onUpdateProject: (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
  onNavigate?: (view: string, id?: string) => void;
}



export const ProjectDashboard: React.FC<ProjectDashboardProps> = ({
  projects, onCreateProject, onOpenProject, onDeleteProject, onDuplicateProject, onReadProject, onUpdateProject, onNavigate
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [createPending, setCreatePending] = useState<NewComicMode | null>(null);
  // Synchronous guard: Enter + click in the same tick must not create two comics.
  const createInFlightRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
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
    <div className="text-center py-20 space-y-8 animate-fade-in">
      <div className="space-y-4 max-w-2xl mx-auto">
        <h1 className="text-5xl font-display text-black leading-tight">No comics yet</h1>
        <p className="text-lg font-comic text-slate-600">Describe your idea and the studio plans, draws and letters it with you.</p>
      </div>
      <div className="flex justify-center gap-6">
        <Button onClick={() => setIsCreating(true)} className="text-xl px-12 py-6" icon={<Sparkles />}>Create New Comic</Button>
      </div>

    </div>
  );

  return (
    <div className="max-w-7xl mx-auto p-8 animate-fade-in">
      <DataRescue />
      <ReadinessChecklist onNavigate={(v) => onNavigate?.(v)} />
      {projects.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-brand-yellow border-4 border-black rounded-xl flex items-center justify-center shadow-comic transform -rotate-3">
                <LayoutGrid className="w-8 h-8 text-black" />
              </div>
              <div>
                <h1 className="text-4xl font-display text-black">My Comics</h1>
                <p className="text-slate-600 font-comic font-bold">Manage your studio projects</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Button onClick={() => setIsCreating(true)} icon={<Plus />}>New Comic</Button>
            </div>
          </div>

        </>
      )}

      {notice && (
        <div role="status" className="mb-6 flex items-start gap-2 rounded-xl border-2 border-black bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isCreating && (
        <div className="mb-12 mx-auto bg-white p-6 rounded-xl border-4 border-black shadow-comic max-w-2xl relative z-50">
          <label htmlFor="new-comic-title" className="block text-lg font-display mb-2 text-black">Comic Title</label>
          <input
            id="new-comic-title"
            autoFocus
            type="text"
            value={newProjectName}
            maxLength={PROJECT_NAME_MAX}
            disabled={!!createPending}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="The Amazing Adventures of..."
            className="w-full border-2 border-black bg-white text-black rounded-lg px-4 py-2 font-comic text-lg focus:shadow-comic outline-none transition-all placeholder-slate-400 disabled:opacity-60"
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate('studio')}
          />

          <div className="mt-5 rounded-lg border-2 border-black bg-slate-50 p-4">
            <div className="flex items-center gap-2 font-display text-black"><MessageSquare className="w-5 h-5" /> Comic Studio</div>
            <p className="mt-1 text-xs font-comic text-slate-600">
              Talk through your idea — the studio plans pages, keeps characters consistent, and letters every balloon.
              You see the page plan and the cost before anything is drawn.
            </p>
          </div>

          {createError && (
            <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border-2 border-black bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{createError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 mt-5">
            <Button onClick={() => void handleCreate('studio')} isLoading={createPending === 'studio'} disabled={!!createPending}>
              {createPending === 'studio' ? 'Creating…' : 'Create'}
            </Button>
            <Button variant="secondary" onClick={() => { setIsCreating(false); setCreateError(null); }} disabled={!!createPending}>Cancel</Button>
            <button
              type="button"
              onClick={() => void handleCreate('classic')}
              disabled={!!createPending}
              className="ml-auto text-xs font-bold text-slate-500 underline-offset-2 hover:text-black hover:underline disabled:opacity-50"
            >
              Use the classic editor instead
            </button>
          </div>
        </div>
      )}

      {projects.length === 0 ? renderLanding() : (
        <>
          <div className="bg-white border-4 border-black rounded-xl shadow-comic p-4 mb-6">
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search projects..."
                className="flex-1 border-2 border-black rounded-lg px-3 py-2 text-sm font-bold"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setFilterFeatured((prev) => !prev)}
                  className={`px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 ${filterFeatured ? 'bg-brand-yellow' : 'bg-white'}`}
                >
                  <Star className="w-4 h-4" /> Featured
                </button>
                <button
                  onClick={() => setFilterRecent((prev) => !prev)}
                  className={`px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 ${filterRecent ? 'bg-brand-yellow' : 'bg-white'}`}
                >
                  <Clock className="w-4 h-4" /> Recent Changes
                </button>
                <select
                  value={dateRange}
                  onChange={(e) => setDateRange(e.target.value as any)}
                  className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold"
                >
                  <option value="all">All Dates</option>
                  <option value="7">Last 7 Days</option>
                  <option value="30">Last 30 Days</option>
                  <option value="90">Last 90 Days</option>
                </select>
                <select
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value as any)}
                  className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold"
                >
                  <option value="updated">Recent Updated</option>
                  <option value="created">Recent Created</option>
                  <option value="az">A–Z</option>
                  <option value="za">Z–A</option>
                </select>
                <button
                  onClick={() => setAdvancedOpen((prev) => !prev)}
                  className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1"
                >
                  <Filter className="w-4 h-4" /> More Filters
                </button>
              </div>
            </div>
            {advancedOpen && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-bold">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  className="px-3 py-2 border-2 border-black rounded-lg"
                >
                  <option value="all">All Statuses</option>
                  <option value="generating">Generating</option>
                  <option value="completed">Completed</option>
                  <option value="draft">Draft</option>
                </select>
                <select
                  value={stepFilter}
                  onChange={(e) => setStepFilter(e.target.value as any)}
                  className="px-3 py-2 border-2 border-black rounded-lg"
                >
                  <option value="all">All Steps</option>
                  <option value="script">Script</option>
                  <option value="style">Style</option>
                  <option value="world">World</option>
                  <option value="cover">Cover</option>
                  <option value="layout">Layout</option>
                  <option value="build">Build</option>
                  <option value="done">Done</option>
                </select>
                <div className="flex gap-2">
                  <button
                    onClick={() => setHasCoverFilter((prev) => !prev)}
                    className={`flex-1 px-3 py-2 border-2 border-black rounded-lg ${hasCoverFilter ? 'bg-brand-yellow' : 'bg-white'}`}
                  >
                    Has Cover
                  </button>
                  <button
                    onClick={() => setHasCommentsFilter((prev) => !prev)}
                    className={`flex-1 px-3 py-2 border-2 border-black rounded-lg ${hasCommentsFilter ? 'bg-brand-yellow' : 'bg-white'}`}
                  >
                    Has Comments
                  </button>
                </div>
                <button
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
                  className="px-3 py-2 border-2 border-black rounded-lg bg-white"
                >
                  Reset Filters
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-8">
            {filteredProjects.length === 0 && (
              <div className="col-span-full text-center text-slate-500 font-comic text-lg">
                No projects match the current filters.
              </div>
            )}
	            {displayedProjects.map(project => {
	              const firstPageStudioImage = project.state.pageStudio?.pages?.find((page) => page.imageUrl)?.imageUrl;
	              const previewCandidates = [
	                project.state.coverImageUrl,
	                project.state.panels.find((panel) => panel.imageUrl)?.imageUrl,
	                firstPageStudioImage,
	                project.state.styleVariants.find((variant) => variant.imageUrl)?.imageUrl
	              ].filter((value): value is string => Boolean(value));
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
                <div key={project.id} className="group bg-white rounded-xl border-4 border-black shadow-comic hover:-translate-y-2 hover:shadow-[8px_8px_0px_0px_#000] transition-all duration-300 flex flex-col overflow-hidden">
                  <div className="aspect-video bg-slate-100 border-b-4 border-black relative overflow-hidden">
                    {primaryPreview ? (
                      <SmartImage
                        src={primaryPreview}
                        fallbackSources={fallbackPreviews}
                        alt={`${project.name} cover`}
	                        className={`w-full h-full object-cover ${isStudio ? 'object-top' : ''} ${!hasCoverPreview && !hasPanelPreview && !hasPageStudioPreview && !hasStylePreview ? 'opacity-50 grayscale' : ''}`}
                        loadingComponent={<div className="w-full h-full flex items-center justify-center bg-slate-50"><div className="w-8 h-8 border-4 border-brand-blue border-t-transparent rounded-full animate-spin"></div></div>}
                        fallbackIcon={<div className="font-display text-4xl text-brand-blue/30">?</div>}
                        containerClassName="w-full h-full"
                      />
                    ) : isStudio ? (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-slate-50 text-slate-400">
                        <MessageSquare className="h-9 w-9" aria-hidden />
                        <span className="text-xs font-bold">Nothing drawn yet</span>
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-brand-blue/10 text-brand-blue/50 font-display text-6xl">?</div>
                    )}

                    {isStudio && (
                      <span
                        data-testid="studio-badge"
                        title="Made in the conversational Comic Studio"
                        className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border-2 border-black bg-white px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-black shadow-[2px_2px_0px_0px_#000]"
                      >
                        <Sparkles className="h-3 w-3" aria-hidden /> Studio
                      </span>
                    )}

                    {project.state.generationStatus?.isActive && (
                      <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center text-white p-4">
                        <div className="text-brand-yellow font-display text-2xl animate-pulse mb-2">Generating...</div>
                        <div className="w-full h-2 bg-white/20 rounded-full mb-2 overflow-hidden">
                          <div className="h-full bg-brand-yellow transition-all duration-500" style={{ width: `${project.state.generationStatus.progress}%` }} />
                        </div>
                        <div className="font-mono text-xs text-slate-300">Est: {project.state.generationStatus.estimatedTimeRemaining}</div>
                      </div>
                    )}

                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity gap-2">
                      <Button size="sm" onClick={() => onReadProject(project.id)} icon={<BookOpen size={16} />}>Read</Button>
                      <Button size="sm" variant="secondary" onClick={() => onOpenProject(project.id)} icon={<Edit size={16} />}>{isStudio ? 'Open' : 'Edit'}</Button>
                      <Button size="sm" variant="outline" onClick={() => setInfoProjectId(project.id)} icon={<Info size={16} />}>Info</Button>
                    </div>
                  </div>
                  <div className="p-5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      {renamingId === project.id ? (
                        <TitleRenameInput initial={project.name} onDone={(value) => commitRename(project, value)} />
                      ) : (
                        <div className="group/title flex min-w-0 items-center gap-1">
                          <h3 className="text-2xl font-display truncate">{project.name}</h3>
                          <button
                            onClick={() => setRenamingId(project.id)}
                            className="shrink-0 rounded-full p-1 text-slate-400 opacity-60 hover:bg-slate-100 hover:text-black group-hover/title:opacity-100 focus:opacity-100"
                            title="Rename"
                            aria-label={`Rename ${project.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                      <button
                        onClick={() => onUpdateProject(project.id, (prev) => ({
                          state: { ...prev.state, isFeatured: !prev.state.isFeatured }
                        }))}
                        className={`p-1 border-2 border-black rounded-full ${project.state.isFeatured ? 'bg-brand-yellow' : 'bg-white'}`}
                        title="Toggle Featured"
                        aria-label={project.state.isFeatured ? "Unmark as featured" : "Mark as featured"}
                      >
                        <Star className={`w-4 h-4 ${project.state.isFeatured ? 'fill-black' : ''}`} />
                      </button>
                    </div>
                    <div className="flex justify-between items-center mb-4">
                      <p className="text-xs text-slate-500 font-mono">Updated: {new Date(project.updatedAt).toLocaleDateString()}</p>
                      {project.state.generationStatus?.isActive && <span className="text-xs font-bold bg-brand-yellow px-2 py-0.5 rounded border border-black animate-pulse">BUILDING</span>}
                    </div>

                    {studioProgress && (
                      <div className="-mt-2 mb-4" data-testid="studio-progress">
                        <div className="flex items-center justify-between text-xs font-bold text-slate-600">
                          <span>{formatStudioProgress(studioProgress)}</span>
                          {studioProgress.pages > 0 && studioProgress.rendered >= studioProgress.pages && (
                            <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Drawn</span>
                          )}
                        </div>
                        {studioProgress.pages > 0 && (
                          <div
                            className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"
                            role="progressbar"
                            aria-label="Pages drawn"
                            aria-valuemin={0}
                            aria-valuemax={studioProgress.pages}
                            aria-valuenow={studioProgress.rendered}
                          >
                            <div className="h-full bg-brand-yellow transition-all duration-500" style={{ width: `${(studioProgress.rendered / studioProgress.pages) * 100}%` }} />
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex justify-between border-t-2 border-slate-100 pt-4">
                      {isStudio ? (
                        // A studio comic's content lives server-side (comic_docs); copying the
                        // listing row would make a comic with no document — so not yet.
                        <span title={DUPLICATE_UNAVAILABLE_FOR_STUDIO}>
                          <button
                            disabled
                            aria-disabled="true"
                            aria-label={DUPLICATE_UNAVAILABLE_FOR_STUDIO}
                            className="text-slate-300 flex items-center gap-1 text-xs font-bold uppercase cursor-not-allowed"
                          >
                            <Copy size={14} /> Duplicate
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => onDuplicateProject(project.id)} className="text-slate-500 hover:text-brand-blue flex items-center gap-1 text-xs font-bold uppercase">
                          <Copy size={14} /> Duplicate
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
                        className="text-slate-500 hover:text-brand-red flex items-center gap-1 text-xs font-bold uppercase"
                      >
                        <Trash2 size={14} /> Delete
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
        <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"><div className="bg-white p-4 rounded-xl border-4 border-black"><Loader2 className="animate-spin w-8 h-8" /></div></div>}>
          <ProjectInfoModal
            project={infoProject}
            onClose={() => setInfoProjectId(null)}
            onUpdateProject={onUpdateProject}
          />
        </Suspense>
      )}
    </div>
  );
};

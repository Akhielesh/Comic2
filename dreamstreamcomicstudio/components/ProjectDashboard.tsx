import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { Plus, BookOpen, Edit, Trash2, Copy, LayoutGrid, Sparkles, Zap, CheckCircle2, XCircle, AlertTriangle, Info, Star, Filter, Calendar, ArrowDownAZ, ArrowUpAZ, Clock, Loader2 } from 'lucide-react';
import { AppStep, Project } from '../types';
import { Button } from './Button';
// Lazy load ProjectInfoModal
// Lazy load ProjectInfoModal
const ProjectInfoModal = React.lazy(() => import('./modals/ProjectInfoModal').then(module => ({ default: module.ProjectInfoModal })));
import { DataRescue } from './DataRescue';
import { getFluxKeyInfo } from '../services/appSettings';
import { SmartImage } from './common/SmartImage';

interface ProjectDashboardProps {
  projects: Project[];
  onCreateProject: (name: string) => void;
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
  const [stepFilter, setStepFilter] = useState<'all' | 'script' | 'plan' | 'style' | 'world' | 'cover' | 'layout' | 'preview' | 'build' | 'done'>('all');

  const filteredProjects = useMemo(() => {
    const now = Date.now();
    const maxAgeDays = dateRange === 'all' ? null : Number(dateRange);
    const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const dateCutoff = maxAgeDays ? now - maxAgeDays * 24 * 60 * 60 * 1000 : null;

    const matchesStep = (project: Project) => {
      if (stepFilter === 'all') return true;
      const step = project.state.step;
      switch (stepFilter) {
        case 'script': return step === AppStep.SCRIPT_INPUT;
        case 'plan': return step === AppStep.STORY_PLANNING;
        case 'style': return step === AppStep.STYLE_SELECTION;
        case 'world': return step === AppStep.REFERENCE_BUILDER;
        case 'cover': return step === AppStep.COVER;
        case 'layout': return step === AppStep.LAYOUT_SELECTION;
        case 'preview': return step === AppStep.COMBINED_PREVIEW;
        case 'build': return step === AppStep.FULL_GENERATION;
        case 'done': return step === AppStep.REVIEW_EXPORT;
        default: return true;
      }
    };

    const matchesStatus = (project: Project) => {
      if (statusFilter === 'all') return true;
      const isGenerating = !!project.state.generationStatus?.isActive;
      const isCompleted = project.state.panels.length > 0 && !isGenerating;
      const isDraft = project.state.panels.length === 0 && !isGenerating;
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

  const handleCreate = () => {
    if (newProjectName.trim()) {
      onCreateProject(newProjectName);
      setNewProjectName('');
      setIsCreating(false);
    }
  };

  const renderLanding = () => (
    <div className="text-center py-20 space-y-8 animate-fade-in">
      <div className="space-y-4 max-w-2xl mx-auto">
        <h1 className="text-5xl font-display text-black leading-tight">No comics yet</h1>
        <p className="text-lg font-comic text-slate-600">Create your first project and start building panels.</p>
      </div>
      <div className="flex justify-center gap-6">
        <Button onClick={() => setIsCreating(true)} className="text-xl px-12 py-6" icon={<Sparkles />}>Create New Comic</Button>
      </div>

    </div>
  );

  return (
    <div className="max-w-7xl mx-auto p-8 animate-fade-in">
      <DataRescue />
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

      {isCreating && (
        <div className="mb-12 mx-auto bg-white p-6 rounded-xl border-4 border-black shadow-comic max-w-xl relative z-50">
          <label className="block text-lg font-display mb-2 text-black">Comic Title</label>
          <div className="flex gap-4">
            <input
              autoFocus
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="The Amazing Adventures of..."
              className="flex-1 border-2 border-black bg-white text-black rounded-lg px-4 py-2 font-comic text-lg focus:shadow-comic outline-none transition-all placeholder-slate-400"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <Button onClick={handleCreate}>Create</Button>
            <Button variant="secondary" onClick={() => setIsCreating(false)}>Cancel</Button>
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
                  <option value="plan">Plan</option>
                  <option value="style">Style</option>
                  <option value="world">World</option>
                  <option value="cover">Cover</option>
                  <option value="layout">Layout</option>
                  <option value="preview">Preview</option>
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
              const previewCandidates = [
                project.state.coverImageUrl,
                project.state.panels.find((panel) => panel.imageUrl)?.imageUrl,
                project.state.styleVariants.find((variant) => variant.imageUrl)?.imageUrl
              ].filter((value): value is string => Boolean(value));
              const primaryPreview = previewCandidates[0];
              const fallbackPreviews = previewCandidates.slice(1);
              const hasPanelPreview = project.state.panels.some((panel) => panel.imageUrl);
              const hasStylePreview = project.state.styleVariants.some((variant) => variant.imageUrl);
              const hasCoverPreview = Boolean(project.state.coverImageUrl);

              return (
                <div key={project.id} className="group bg-white rounded-xl border-4 border-black shadow-comic hover:-translate-y-2 hover:shadow-[8px_8px_0px_0px_#000] transition-all duration-300 flex flex-col overflow-hidden">
                  <div className="aspect-video bg-slate-100 border-b-4 border-black relative overflow-hidden">
                    {primaryPreview ? (
                      <SmartImage
                        src={primaryPreview}
                        fallbackSources={fallbackPreviews}
                        alt={`${project.name} cover`}
                        className={`w-full h-full object-cover ${!hasCoverPreview && !hasPanelPreview && !hasStylePreview ? 'opacity-50 grayscale' : ''}`}
                        loadingComponent={<div className="w-full h-full flex items-center justify-center bg-slate-50"><div className="w-8 h-8 border-4 border-brand-blue border-t-transparent rounded-full animate-spin"></div></div>}
                        fallbackIcon={<div className="font-display text-4xl text-brand-blue/30">?</div>}
                        containerClassName="w-full h-full"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-brand-blue/10 text-brand-blue/50 font-display text-6xl">?</div>
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
                      <Button size="sm" variant="secondary" onClick={() => onOpenProject(project.id)} icon={<Edit size={16} />}>Edit</Button>
                      <Button size="sm" variant="outline" onClick={() => setInfoProjectId(project.id)} icon={<Info size={16} />}>Info</Button>
                    </div>
                  </div>
                  <div className="p-5">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-2xl font-display truncate">{project.name}</h3>
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

                    <div className="flex justify-between border-t-2 border-slate-100 pt-4">
                      <button onClick={() => onDuplicateProject(project.id)} className="text-slate-500 hover:text-brand-blue flex items-center gap-1 text-xs font-bold uppercase">
                        <Copy size={14} /> Duplicate
                      </button>
                      <button onClick={() => onDeleteProject(project.id)} className="text-slate-500 hover:text-brand-red flex items-center gap-1 text-xs font-bold uppercase">
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

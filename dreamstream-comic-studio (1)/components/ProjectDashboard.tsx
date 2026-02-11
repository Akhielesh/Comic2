import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { Plus, BookOpen, Edit, Trash2, Copy, LayoutGrid, Sparkles, Zap, CheckCircle2, XCircle, AlertTriangle, Info, Star, Filter, Calendar, ArrowDownAZ, ArrowUpAZ, Clock, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { Project } from '../types';
import { Button } from './Button';
const ProjectInfoModal = React.lazy(() => import('./modals/ProjectInfoModal').then(module => ({ default: module.ProjectInfoModal })));
import { DataRescue } from './DataRescue';
import { getFluxKeyInfo } from '../services/appSettings';
import { NotificationBell } from './NotificationBell';
import { SmartImage } from './common/SmartImage';

interface ProjectDashboardProps {
  projects: Project[];
  onCreateProject: (name: string) => void;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onDuplicateProject: (id: string) => void;
  onReadProject: (id: string) => void;
  onUpdateProject: (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) => void;
}

export const ProjectDashboard: React.FC<ProjectDashboardProps> = ({
  projects, onCreateProject, onOpenProject, onDeleteProject, onDuplicateProject, onReadProject, onUpdateProject
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [infoProjectId, setInfoProjectId] = useState<string | null>(null);
  const infoProject = infoProjectId ? projects.find((p) => p.id === infoProjectId) : undefined;
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState<'updated' | 'created' | 'az' | 'za'>('updated');
  const [filterFeatured, setFilterFeatured] = useState(false);
  const [filterRecent, setFilterRecent] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const filteredProjects = useMemo(() => {
    const now = Date.now();
    const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;

    return projects
      .filter((project) => {
        const search = searchTerm.trim().toLowerCase();
        const matchesSearch =
          !search ||
          project.name.toLowerCase().includes(search) ||
          (project.state.overview || '').toLowerCase().includes(search);

        const matchesFeatured = !filterFeatured || !!project.state.isFeatured;
        const matchesRecent = !filterRecent || project.updatedAt >= recentCutoff;

        return matchesSearch && matchesFeatured && matchesRecent;
      })
      .sort((a, b) => {
        if (sortOption === 'updated') return b.updatedAt - a.updatedAt;
        if (sortOption === 'created') return b.createdAt - a.createdAt;
        if (sortOption === 'az') return a.name.localeCompare(b.name);
        if (sortOption === 'za') return b.name.localeCompare(a.name);
        return 0;
      });
  }, [projects, searchTerm, filterFeatured, filterRecent, sortOption]);

  const [visibleCount, setVisibleCount] = useState(12);

  useEffect(() => {
    setVisibleCount(12);
  }, [searchTerm, filterFeatured, filterRecent, sortOption]);

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
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
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
              <NotificationBell onNavigate={onOpenProject ? ((v, id) => { if (v === 'reader' && id) onReadProject(id) }) : undefined as any} />
              <Button onClick={() => setIsCreating(true)} icon={<Plus />}>New Comic</Button>
            </div>
        </div>
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
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search projects..."
                className="flex-1 border-2 border-black rounded-lg px-3 py-2 text-sm font-bold bg-slate-50"
              />
              <div className="flex items-center gap-2">
                 <button
                    onClick={() => setIsFilterOpen(!isFilterOpen)}
                    className={`px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 bg-white hover:bg-slate-50 transition-colors`}
                 >
                    <Filter className="w-4 h-4" /> Filters {isFilterOpen ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
                 </button>
                 <select
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value as any)}
                  className="px-3 py-2 border-2 border-black rounded-lg text-xs font-bold bg-white"
                >
                  <option value="updated">Recent Updated</option>
                  <option value="created">Recent Created</option>
                  <option value="az">A–Z</option>
                  <option value="za">Z–A</option>
                </select>
              </div>
            </div>

            {isFilterOpen && (
                <div className="mt-4 pt-4 border-t-2 border-slate-100 flex flex-wrap gap-2 animate-fade-in">
                    <button
                    onClick={() => setFilterFeatured((prev) => !prev)}
                    className={`px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 ${filterFeatured ? 'bg-brand-yellow' : 'bg-white'}`}
                    >
                    <Star className="w-4 h-4" /> Featured Only
                    </button>
                    <button
                    onClick={() => setFilterRecent((prev) => !prev)}
                    className={`px-3 py-2 border-2 border-black rounded-lg text-xs font-bold flex items-center gap-1 ${filterRecent ? 'bg-brand-yellow' : 'bg-white'}`}
                    >
                    <Clock className="w-4 h-4" /> Recently Updated (7 Days)
                    </button>
                     <button
                        onClick={() => {
                            setSearchTerm('');
                            setSortOption('updated');
                            setFilterFeatured(false);
                            setFilterRecent(false);
                        }}
                        className="px-3 py-2 border-2 border-black rounded-lg bg-white text-xs font-bold text-slate-500 hover:text-black ml-auto"
                        >
                        Reset All
                    </button>
                </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
            {filteredProjects.length === 0 && (
              <div className="col-span-full text-center text-slate-500 font-comic text-lg py-10">
                No projects match the current filters.
              </div>
            )}
            {displayedProjects.map(project => {
              let imgSrc = project.state.coverImageUrl;
              if (!imgSrc && project.state.panels.some(p => p.imageUrl)) {
                imgSrc = project.state.panels.find(p => p.imageUrl)?.imageUrl;
              }
              if (!imgSrc && project.state.styleVariants.length > 0) {
                imgSrc = project.state.styleVariants[0].imageUrl;
              }

              return (
                <div key={project.id} className="group bg-white rounded-xl border-4 border-black shadow-comic hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_#000] transition-all duration-300 flex flex-col overflow-hidden">
                  <div className="aspect-video bg-slate-100 border-b-4 border-black relative overflow-hidden">
                    {imgSrc ? (
                      <SmartImage
                        src={imgSrc}
                        alt={`${project.name} cover`}
                        className={`w-full h-full object-cover ${!project.state.coverImageUrl && !project.state.panels.some(p => p.imageUrl) ? 'opacity-80 grayscale' : ''}`}
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
                      </div>
                    )}

                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity gap-2">
                      <Button size="sm" onClick={() => onReadProject(project.id)} icon={<BookOpen size={16} />}>Read</Button>
                      <Button size="sm" variant="secondary" onClick={() => onOpenProject(project.id)} icon={<Edit size={16} />}>Edit</Button>
                      <Button size="sm" variant="outline" onClick={() => setInfoProjectId(project.id)} icon={<Info size={16} />}>Info</Button>
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-xl font-display truncate pr-2">{project.name}</h3>
                      <button
                        onClick={() => onUpdateProject(project.id, (prev) => ({
                          state: { ...prev.state, isFeatured: !prev.state.isFeatured }
                        }))}
                        className={`p-1 hover:bg-slate-100 rounded-full transition-colors`}
                      >
                        <Star className={`w-5 h-5 ${project.state.isFeatured ? 'fill-brand-yellow text-black' : 'text-slate-300'}`} />
                      </button>
                    </div>
                    <div className="flex justify-between items-center text-xs text-slate-500 font-mono mb-3">
                      <span>Updated: {new Date(project.updatedAt).toLocaleDateString()}</span>
                       {project.state.generationStatus?.isActive && <span className="font-bold text-brand-blue">BUILDING</span>}
                    </div>

                    <div className="flex justify-end gap-2 pt-3 border-t-2 border-slate-100 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => onDuplicateProject(project.id)} className="text-slate-400 hover:text-brand-blue p-1" title="Duplicate">
                        <Copy size={16} />
                      </button>
                      <button onClick={() => onDeleteProject(project.id)} className="text-slate-400 hover:text-brand-red p-1" title="Delete">
                        <Trash2 size={16} />
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

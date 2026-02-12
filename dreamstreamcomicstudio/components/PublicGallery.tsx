import React, { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';
import { Loader2, Heart, Eye, Search, BookOpen, User, Star } from 'lucide-react';
import { Project } from '../types';
import { getImageUrl, getProjectLikeMap, toggleProjectLike } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { IMAGE_TRANSFORMS } from '../services/projectStorage';

interface PublicGalleryProps {
    onReadComic: (projectId: string) => void;
    onBack: () => void;
    onRequireAuth?: () => void;
}

interface PublicProject extends Project {
    average_rating?: number;
    review_count?: number;
    isLiked?: boolean;
}

const normalizeTimestamp = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = new Date(value).getTime();
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
};

const fallbackUsernameFromId = (userId?: string): string => {
    if (!userId) return 'Unknown creator';
    return `user-${userId.slice(0, 8)}`;
};

export const PublicGallery: React.FC<PublicGalleryProps> = ({ onReadComic, onBack, onRequireAuth }) => {
    const { user } = useAuth();
    const [projects, setProjects] = useState<PublicProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'trending' | 'recent'>('trending');
    const [search, setSearch] = useState('');
    const [likeBusy, setLikeBusy] = useState<Record<string, boolean>>({});

    useEffect(() => {
        fetchComics();
    }, [filter, user?.id]);

    const hydratePreview = async (project: PublicProject): Promise<PublicProject> => {
        const nextProject = structuredClone(project);
        let coverImage = nextProject.coverImage;

        if (!coverImage && nextProject.state.coverImageId) {
            coverImage = await getImageUrl(nextProject.state.coverImageId, { transform: IMAGE_TRANSFORMS.thumb });
        }

        if (Array.isArray(nextProject.state.panels)) {
            const index = nextProject.state.panels.findIndex((panel) => !panel.imageUrl && !!panel.imageId);
            if (index >= 0) {
                const panel = nextProject.state.panels[index];
                const previewUrl = panel.imageId
                    ? await getImageUrl(panel.imageId, { transform: IMAGE_TRANSFORMS.thumb })
                    : undefined;
                if (previewUrl) {
                    nextProject.state.panels[index] = { ...panel, imageUrl: previewUrl };
                }
            }
        }

        if (Array.isArray(nextProject.state.styleVariants)) {
            const index = nextProject.state.styleVariants.findIndex((variant) => !variant.imageUrl && !!variant.imageId);
            if (index >= 0) {
                const variant = nextProject.state.styleVariants[index];
                const previewUrl = variant.imageId
                    ? await getImageUrl(variant.imageId, { transform: IMAGE_TRANSFORMS.thumb })
                    : undefined;
                if (previewUrl) {
                    nextProject.state.styleVariants[index] = { ...variant, imageUrl: previewUrl };
                }
            }
        }

        return {
            ...nextProject,
            coverImage
        };
    };

    const fetchComics = async () => {
        setLoading(true);
        try {
            let query = supabase
                .from('projects')
                .select('*')
                .eq('is_public', true);

            if (filter === 'trending') query = query.order('likes_count', { ascending: false });
            else query = query.order('created_at', { ascending: false });

            let { data, error } = await query;
            if (error && filter === 'trending') {
                // Schema fallback when likes_count is unavailable
                const fallback = await supabase
                    .from('projects')
                    .select('*')
                    .eq('is_public', true)
                    .order('created_at', { ascending: false });
                data = fallback.data;
                error = fallback.error;
            }
            if (error) throw error;

            const rows = (data || []).filter((p: any) =>
                p &&
                typeof p.id === 'string' &&
                typeof p.name === 'string' &&
                typeof p.created_at === 'string' &&
                typeof p.updated_at === 'string' &&
                typeof p.state === 'object'
            );
            const userIds = Array.from(
                new Set(
                    rows
                        .map((row: any) => (typeof row.user_id === 'string' ? row.user_id : undefined))
                        .filter((id: string | undefined): id is string => !!id)
                )
            );

            const authorMap = new Map<string, string>();
            if (userIds.length > 0) {
                const { data: profiles, error: profileError } = await supabase
                    .from('profiles')
                    .select('id, username')
                    .in('id', userIds);
                if (profileError) {
                    console.warn('Failed to load author usernames for public gallery.', profileError);
                } else {
                    (profiles || []).forEach((profile: any) => {
                        if (!profile || typeof profile.id !== 'string') return;
                        if (typeof profile.username === 'string' && profile.username.trim()) {
                            authorMap.set(profile.id, profile.username.trim());
                        }
                    });
                }
            }

            const mapped = rows.map((row: any): PublicProject => {
                const createdAt = new Date(row.created_at).getTime();
                const publishedAt =
                    normalizeTimestamp(row.published_at)
                    ?? normalizeTimestamp(row.state?.publishedAt)
                    ?? createdAt;
                const likesCount = typeof row.likes_count === 'number'
                    ? row.likes_count
                    : (typeof row.likes === 'number' ? row.likes : 0);
                const viewsCount = typeof row.views_count === 'number'
                    ? row.views_count
                    : (typeof row.views === 'number' ? row.views : 0);

                return {
                    id: row.id,
                    name: row.name,
                    createdAt,
                    updatedAt: new Date(row.updated_at).getTime(),
                    publishedAt,
                    coverImage: typeof row.cover_image_url === 'string' ? row.cover_image_url : undefined,
                    state: row.state as Project['state'],
                    isPublic: !!row.is_public,
                    userId: typeof row.user_id === 'string' ? row.user_id : undefined,
                    authorName: authorMap.get(row.user_id) || fallbackUsernameFromId(row.user_id),
                    likesCount,
                    viewsCount,
                    average_rating: 0,
                    review_count: 0
                };
            });
            const hydrated = await Promise.all(mapped.map((project: PublicProject) => hydratePreview(project)));

            const likeMap = await getProjectLikeMap(hydrated.map((project: PublicProject) => project.id));
            setProjects(hydrated.map((project: PublicProject) => ({
                ...project,
                isLiked: !!likeMap[project.id]
            })));
        } catch (e) {
            console.error('Failed to load gallery', e);
            setProjects([]);
        } finally {
            setLoading(false);
        }
    };

    const filteredProjects = projects.filter((project) =>
        project.name.toLowerCase().includes(search.toLowerCase()) ||
        (project.authorName || '').toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="min-h-screen bg-slate-50 font-sans pb-20">
            <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
                <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                        <button onClick={onBack} className="text-xs font-bold text-slate-500 hover:text-black mb-2">
                            Back Home
                        </button>
                        <h1 className="font-display text-3xl text-black">Library</h1>
                        <p className="text-sm font-comic text-slate-500">Browse public comics from creators.</p>
                    </div>

                    <div className="flex-1 md:max-w-lg relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                        <input
                            type="text"
                            placeholder="Search comics, authors..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 border-2 border-slate-200 rounded-full focus:border-black focus:outline-none font-comic text-sm"
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setFilter('trending')}
                            className={`px-4 py-2 rounded-full text-xs font-bold uppercase border-2 transition-all ${filter === 'trending' ? 'bg-black text-white border-black' : 'bg-white text-slate-500 border-slate-200 hover:border-black'}`}
                        >
                            Trending
                        </button>
                        <button
                            onClick={() => setFilter('recent')}
                            className={`px-4 py-2 rounded-full text-xs font-bold uppercase border-2 transition-all ${filter === 'recent' ? 'bg-black text-white border-black' : 'bg-white text-slate-500 border-slate-200 hover:border-black'}`}
                        >
                            Recent
                        </button>
                    </div>
                </div>

                {!user && (
                    <div className="mb-6 border-2 border-black rounded-xl bg-white p-4 flex flex-wrap items-center gap-3 justify-between">
                        <p className="text-sm font-bold text-slate-700">Log in to read comics, like, and comment.</p>
                        <button
                            type="button"
                            onClick={onRequireAuth}
                            className="text-xs font-bold border-2 border-black rounded-lg px-3 py-1 bg-brand-yellow hover:bg-yellow-300"
                        >
                            Log In
                        </button>
                    </div>
                )}

                {loading ? (
                    <div className="flex justify-center py-20">
                        <Loader2 className="w-10 h-10 animate-spin text-slate-300" />
                    </div>
                ) : filteredProjects.length === 0 ? (
                    <div className="text-center py-20">
                        <div className="inline-block p-6 bg-white rounded-full mb-4 border-4 border-slate-100">
                            <BookOpen size={48} className="text-slate-300" />
                        </div>
                        <h2 className="text-2xl font-display text-slate-400">No comics found.</h2>
                        <p className="text-slate-500 font-comic mt-2">Be the first to publish one!</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        {filteredProjects.map((project) => {
                            let imgSrc = project.coverImage;
                            // Fallback to first panel or style variant if no cover
                            if (!imgSrc && project.state?.panels?.some((p: any) => p.imageUrl)) {
                                imgSrc = project.state.panels.find((p: any) => p.imageUrl)?.imageUrl;
                            }
                            if (!imgSrc && project.state?.styleVariants?.length > 0) {
                                imgSrc = project.state.styleVariants[0].imageUrl;
                            }

                            return (
                                <div
                                    key={project.id}
                                    onClick={() => onReadComic(project.id)}
                                    className="bg-white rounded-xl border-2 border-slate-200 overflow-hidden hover:border-black hover:shadow-comic hover:-translate-y-1 transition-all cursor-pointer group"
                                >
                                    {/* Cover Aspect Ratio 2:3 */}
                                    <div className="aspect-[2/3] bg-slate-100 relative overflow-hidden">
                                        {imgSrc ? (
                                            <img src={imgSrc} alt={project.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-slate-300">
                                                <BookOpen size={40} />
                                            </div>
                                        )}

                                        {/* Overlay info */}
                                        <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-black/80 to-transparent p-4 text-white pt-10">
                                            <h3 className="font-display text-lg leading-tight mb-1">{project.name}</h3>
                                            <div className="flex items-center gap-1 text-xs font-mono text-white/70">
                                                <User size={10} /> {project.authorName || 'Unknown creator'}
                                            </div>
                                            <div className="text-[10px] font-mono text-white/60 mt-1">
                                                Published {new Date(project.publishedAt || project.createdAt).toLocaleDateString()}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Meta Bar */}
                                    <div className="p-3 flex items-center justify-between border-t-2 border-slate-100 bg-white text-xs font-bold text-slate-500">
                                        <div className="flex items-center gap-3">
                                            <button
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!user || likeBusy[project.id]) return;
                                                    setLikeBusy((prev) => ({ ...prev, [project.id]: true }));
                                                    const currentLiked = !!project.isLiked;
                                                    setProjects((prev) => prev.map((p) => {
                                                        if (p.id !== project.id) return p;
                                                        return {
                                                            ...p,
                                                            isLiked: !currentLiked,
                                                            likesCount: Math.max(0, (p.likesCount || 0) + (currentLiked ? -1 : 1))
                                                        };
                                                    }));

                                                    try {
                                                        const result = await toggleProjectLike(project.id, project.userId);
                                                        setProjects((prev) => prev.map((p) => {
                                                            if (p.id !== project.id) return p;
                                                            if (p.isLiked === result.liked) return p;
                                                            return {
                                                                ...p,
                                                                isLiked: result.liked,
                                                                likesCount: Math.max(0, (p.likesCount || 0) + (result.liked ? 1 : -1))
                                                            };
                                                        }));
                                                    } finally {
                                                        setLikeBusy((prev) => ({ ...prev, [project.id]: false }));
                                                    }
                                                }}
                                                className={`flex items-center gap-1 transition-colors z-10 relative ${user ? 'group-hover/btn:text-red-500' : 'opacity-50 cursor-not-allowed'} ${project.isLiked ? 'text-red-500' : 'hover:text-red-500'}`}
                                                disabled={!user || !!likeBusy[project.id]}
                                                title={user ? (project.isLiked ? 'Unlike comic' : 'Like comic') : 'Log in to like comics'}
                                            >
                                                <Heart size={14} className={project.isLiked ? 'fill-current' : ''} /> {project.likesCount || 0}
                                            </button>
                                            <div className="flex items-center gap-1 text-slate-400">
                                                <Eye size={14} /> {project.viewsCount || 0}
                                            </div>
                                        </div>
                                        {project.average_rating !== undefined && project.average_rating > 0 && (
                                            <div className="flex items-center gap-1 font-bold text-brand-yellow drop-shadow-sm">
                                                <Star size={14} fill="currentColor" />
                                                <span className="text-black">{project.average_rating.toFixed(1)}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

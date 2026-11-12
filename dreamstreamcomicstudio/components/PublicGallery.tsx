import React, { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';
import { Heart, Eye, Search, BookOpen, User, Star, Baby, Check } from 'lucide-react';
import { Project } from '../types';
import { getImageUrl, getProjectLikeMap, toggleProjectLike } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { IMAGE_TRANSFORMS } from '../services/projectStorage';
import { isStudioV4Project } from '../services/studioDeepLink';
import { SLUG_RE, SHARE_PATH } from '../shared/comic/publication';
import { isContentRating, type ContentRating } from '../shared/comic/safety';
import { RatingBadge } from './comicstudio/safety/RatingBadge';
import { SmartImage } from './common/SmartImage';
import { cn } from '../lib/utils';
import {
    CANVAS_BG,
    DENSITY,
    DISPLAY_SECTION,
    FIELD_EMBEDDED,
    FIELD_GROUP,
    FOCUS_RING,
    LIFT,
    MUTED,
    PUBLIC_BODY,
    RADIUS_CONTROL,
    RADIUS_PANEL,
    RADIUS_ROUND
} from './chat/studioDesign';
import { HEADER_INNER } from './ds/AppHeader';
import { Button } from './ds/Button';
import { CARD_TITLE } from './ds/Card';
import { EmptyState } from './ds/EmptyState';
import { Segmented } from './ds/Segmented';
import { Skeleton } from './ds/Skeleton';

/** The cover grid: two covers a row on a phone, three from md, four from lg. */
const GRID = 'mt-8 grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 md:grid-cols-3 lg:grid-cols-4';

/** The public bucket that holds published (pub/<key>/…) comic copies. */
const PUBLIC_COMIC_BUCKET = 'comic-assets';

/** A published v4 comic's share slug (server-mirrored onto the listing row), when it has one. */
export const shareSlugOf = (project: Project): string | undefined => {
    const slug = (project.state as unknown as { shareSlug?: unknown } | undefined)?.shareSlug;
    return isStudioV4Project(project) && typeof slug === 'string' && SLUG_RE.test(slug) ? slug : undefined;
};

/** Public URL of a published v4 cover (state.publicCover: an opaque pub/<key>/… path in the public bucket). */
export const publicCoverUrl = (project: Project): string | undefined => {
    const path = (project.state as unknown as { publicCover?: unknown } | undefined)?.publicCover;
    if (!isStudioV4Project(project) || typeof path !== 'string' || !/^pub\/[A-Za-z0-9]{22}\/[A-Za-z0-9._/-]{1,200}$/.test(path) || path.includes('..')) return undefined;
    return supabase.storage.from(PUBLIC_COMIC_BUCKET).getPublicUrl(path).data?.publicUrl || undefined;
};

/** G and PG comics are the kids-friendly ones; an unrated comic is never assumed to be. */
export const isKidsFriendly = (rating: ContentRating | undefined): boolean => rating === 'G' || rating === 'PG';

/**
 * The publish gate's rating of a listing row, honoured only for a real publication: a v4 row
 * carrying its server-mirrored share slug. The column is server-set, but the rest of a row is the
 * owner's, and a row that no longer reads as a publication (say, its studio marker was flipped)
 * shows its art outside the gate — it gets no badge and never counts as kids-friendly.
 */
const gateRatingOf = (row: { content_rating?: unknown; state?: unknown }): ContentRating | undefined =>
    isContentRating(row.content_rating) && shareSlugOf({ state: row.state } as Project) ? row.content_rating : undefined;

/**
 * Ordered cover candidates for a comic: the stored cover first, then the first
 * rendered page, then the first style board. SmartImage walks this list so a
 * missing OR broken cover URL falls back to the first page rather than a
 * "no image" icon — the icon only appears when a comic truly has no art yet.
 * A Comic Studio (v4) comic shows ONLY its public cover (the frozen, safety-cleared pub/ copy):
 * its classic cover fields are owner-writable and never went through the publish gate, so
 * without a public cover the card shows the book icon rather than one of them.
 */
const coverCandidates = (project: Project): string[] => {
    const out: string[] = [];
    const push = (url?: string | null) => { if (typeof url === 'string' && url.trim()) out.push(url); };
    push(publicCoverUrl(project));
    if (isStudioV4Project(project)) return out;
    push(project.coverImage);
    push(project.state?.coverImageUrl);
    push(project.state?.panels?.find((p) => p.imageUrl)?.imageUrl);
    push(project.state?.styleVariants?.find((v) => v.imageUrl)?.imageUrl);
    return Array.from(new Set(out));
};

interface PublicGalleryProps {
    onReadComic: (projectId: string) => void;
    /** Kept for its callers; the page has no Back button (the header's lockup goes home). */
    onBack?: () => void;
    onRequireAuth?: () => void;
}

interface PublicProject extends Project {
    average_rating?: number;
    review_count?: number;
    isLiked?: boolean;
    /** The rating the publish gate assigned (projects.content_rating, server-set). */
    contentRating?: ContentRating;
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

export const PublicGallery: React.FC<PublicGalleryProps> = ({ onReadComic, onRequireAuth }) => {
    const { user } = useAuth();
    const [projects, setProjects] = useState<PublicProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'trending' | 'recent'>('trending');
    const [search, setSearch] = useState('');
    const [kidsOnly, setKidsOnly] = useState(false);
    const [likeBusy, setLikeBusy] = useState<Record<string, boolean>>({});

    useEffect(() => {
        fetchComics();
    }, [filter, user?.id]);

    const hydratePreview = async (project: PublicProject): Promise<PublicProject> => {
        // Comic Studio (v4) comics show only their public cover URL: nothing to sign (their other
        // image ids are drafts, which a public card must never reach).
        if (isStudioV4Project(project)) return project;
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
                typeof p.state === 'object' &&
                // A comic held by moderation is never listed (the server also unlists it; this
                // covers a row written before that fix reached the database).
                p.is_forced_private !== true
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
                const contentRating = gateRatingOf(row);

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
                    review_count: 0,
                    ...(contentRating ? { contentRating } : {})
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
        (!kidsOnly || isKidsFriendly(project.contentRating)) &&
        (project.name.toLowerCase().includes(search.toLowerCase()) ||
            (project.authorName || '').toLowerCase().includes(search.toLowerCase()))
    );

    // The like toggle: the optimistic count, then the server's answer (unchanged behaviour; only the markup moved).
    const toggleLike = async (project: PublicProject) => {
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
    };

    // On the Atlas tokens, as the comics landing above it: the display title, the search / sort / kids filter row,
    // a calm sign-in note, then a grid of covers with their title, creator and counts under the art (ink only: the
    // art is the colour). The header's lockup goes home, so the page carries no Back button of its own.
    return (
        <div className={cn(CANVAS_BG, 'min-h-screen pb-20 font-sans text-[var(--ds-ink)]')}>
            <div className={cn(HEADER_INNER, 'pt-10 sm:pt-14')}>
                <div className="flex min-w-0 flex-col gap-6 border-b border-[var(--ds-hairline)] pb-8 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0">
                        <h1 className={cn(DISPLAY_SECTION, 'text-[var(--ds-ink)]')}>Library</h1>
                        <p className={cn(PUBLIC_BODY, 'mt-3 max-w-xl')}>Browse public comics from creators.</p>
                    </div>

                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:flex-nowrap">
                        <label className={cn(FIELD_GROUP, DENSITY.coarse, 'h-10 min-w-0 px-3 sm:w-72 sm:flex-none')}>
                            <Search aria-hidden className={cn('size-4 shrink-0', MUTED)} />
                            <span className="sr-only">Search comics or creators</span>
                            <input
                                type="search"
                                placeholder="Search comics or creators"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className={cn(FIELD_EMBEDDED, 'h-full text-[length:var(--ds-text-base)] text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)]')}
                            />
                        </label>
                        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
                            <Segmented<'trending' | 'recent'>
                                // A set width: each half holds its whole word ("Trending" never truncates beside "Recent").
                                className="w-48 shrink-0"
                                label="Sort the Library"
                                value={filter}
                                onChange={setFilter}
                                options={[
                                    { value: 'trending', label: 'Trending' },
                                    { value: 'recent', label: 'Recent' }
                                ]}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                aria-pressed={kidsOnly}
                                onClick={() => setKidsOnly((v) => !v)}
                                title="Only comics rated G or PG by the publish check"
                                className="aria-pressed:border-[var(--ds-ink)] aria-pressed:bg-[var(--ds-well)]"
                            >
                                {kidsOnly ? <Check aria-hidden /> : <Baby aria-hidden />} Kids-friendly (G/PG)
                            </Button>
                        </div>
                    </div>
                </div>

                {!user && (
                    <div className={cn(RADIUS_PANEL, 'mt-6 flex flex-wrap items-center justify-between gap-3 border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-4 py-3')}>
                        <p className={cn('m-0 text-[length:var(--ds-text-base)] leading-6', MUTED)}>Reading is free — no account needed. Sign in to like, comment and share.</p>
                        <Button type="button" size="sm" variant="outline" className={RADIUS_ROUND} onClick={onRequireAuth}>
                            Sign in
                        </Button>
                    </div>
                )}

                {loading ? (
                    <div role="status" aria-label="Loading the Library" className={GRID}>
                        {Array.from({ length: 8 }, (_, i) => (
                            <div key={i} className="min-w-0">
                                <Skeleton className={cn('aspect-[2/3] w-full', RADIUS_PANEL)} />
                                <Skeleton shape="text" className="mt-3 w-3/4" />
                                <Skeleton shape="text" className="mt-2 w-1/2" />
                            </div>
                        ))}
                    </div>
                ) : filteredProjects.length === 0 ? (
                    <EmptyState
                        as="h2"
                        className="mt-8"
                        icon={<BookOpen aria-hidden />}
                        title={kidsOnly ? 'No kids-friendly comics yet.' : 'No comics found.'}
                        description={kidsOnly ? 'Only comics rated G or PG show here. Turn the filter off to see everything.' : 'Be the first to publish one!'}
                    />
                ) : (
                    <ul className={GRID}>
                        {filteredProjects.map((project) => {
                            const covers = coverCandidates(project);
                            // Published v4 comics open their read-only share link (/c/<slug>) as a real
                            // page load: it serves the boot card, the preview head and its own CSP.
                            const slug = shareSlugOf(project);
                            const coverClass = cn('block', RADIUS_PANEL, FOCUS_RING);
                            const coverArea = (children: React.ReactNode) =>
                                slug ? (
                                    <a href={SHARE_PATH(slug)} aria-label={`Read ${project.name}`} className={coverClass}>
                                        {children}
                                    </a>
                                ) : (
                                    // Classic comics open in-app; the href keeps open-in-new-tab and copy-link working.
                                    <a
                                        href={`/?view=read&id=${encodeURIComponent(project.id)}`}
                                        onClick={(e) => {
                                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                                            e.preventDefault();
                                            onReadComic(project.id);
                                        }}
                                        aria-label={`Read ${project.name}`}
                                        className={coverClass}
                                    >
                                        {children}
                                    </a>
                                );
                            const likeLabel = user ? (project.isLiked ? 'Unlike comic' : 'Like comic') : 'Sign in to like comics';

                            return (
                                <li key={project.id} data-testid="gallery-card" data-share-slug={slug} className="min-w-0">
                                    {coverArea(
                                        /* Cover, 2:3 */
                                        <div className={cn(RADIUS_PANEL, LIFT, 'relative aspect-[2/3] overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]')}>
                                            <SmartImage
                                                src={covers[0]}
                                                fallbackSources={covers.slice(1)}
                                                alt={project.name}
                                                className="h-full w-full object-cover"
                                                containerClassName="w-full h-full"
                                                fallbackIcon={<BookOpen aria-hidden className={cn('size-10', MUTED)} />}
                                            />
                                            {project.contentRating && (
                                                <div className="absolute left-2 top-2">
                                                    <RatingBadge rating={project.contentRating} onArt />
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    <div className="mt-3 min-w-0">
                                        <h3 className={cn(CARD_TITLE, 'line-clamp-2 text-[var(--ds-ink)] [overflow-wrap:anywhere]')}>{project.name}</h3>
                                        <p className={cn('m-0 mt-1 flex min-w-0 items-center gap-1 text-[length:var(--ds-text-sm)] leading-5', MUTED)}>
                                            <User aria-hidden className="size-3 shrink-0" />
                                            <span className="truncate">{project.authorName || 'Unknown creator'}</span>
                                        </p>
                                        <p className={cn('m-0 text-[length:var(--ds-text-xs)] leading-4', MUTED)}>
                                            Published {new Date(project.publishedAt || project.createdAt).toLocaleDateString()}
                                        </p>
                                        <div className={cn('mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 text-[length:var(--ds-text-sm)] tabular-nums', MUTED)}>
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    void toggleLike(project);
                                                }}
                                                aria-pressed={user ? !!project.isLiked : undefined}
                                                aria-label={`${likeLabel}, ${project.likesCount || 0} likes`}
                                                title={likeLabel}
                                                disabled={!user || !!likeBusy[project.id]}
                                                className={cn(
                                                    '-ml-1 inline-flex items-center gap-1 px-1 py-1 transition-colors duration-[var(--ds-motion-fast)] hover:text-[var(--ds-ink)] disabled:cursor-not-allowed disabled:opacity-50',
                                                    RADIUS_CONTROL,
                                                    DENSITY.coarseSquare,
                                                    FOCUS_RING,
                                                    project.isLiked && 'text-[var(--ds-ink)]'
                                                )}
                                            >
                                                <Heart aria-hidden className={cn('size-3.5', project.isLiked && 'fill-current')} /> {project.likesCount || 0}
                                            </button>
                                            <span className="inline-flex items-center gap-1">
                                                <Eye aria-hidden className="size-3.5" />
                                                <span className="sr-only">Views:</span> {project.viewsCount || 0}
                                            </span>
                                            {project.average_rating !== undefined && project.average_rating > 0 && (
                                                <span className="inline-flex items-center gap-1">
                                                    <Star aria-hidden className="size-3.5" fill="currentColor" />
                                                    <span className="sr-only">Average rating:</span>
                                                    <span className="text-[var(--ds-ink)]">{project.average_rating.toFixed(1)}</span>
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
};

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Baby, BookOpen, Check, Eye, Heart, Search, X } from 'lucide-react';
import { supabase } from '../services/supabase';
import { Project } from '../types';
import { GALLERY_CARD_SELECT, GALLERY_PAGE_SIZE, galleryCardStateOf, getImageUrl, getProjectLikeMap, toggleProjectLike } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { IMAGE_TRANSFORMS } from '../services/projectStorage';
import { isStudioV4Project } from '../services/studioDeepLink';
import { SLUG_RE, SHARE_PATH } from '../shared/comic/publication';
import { isContentRating, type ContentRating } from '../shared/comic/safety';
import { RatingBadge } from './comicstudio/safety/RatingBadge';
import { SmartImage } from './common/SmartImage';
import { cn } from '../lib/utils';
import { FOCUS_RING, RADIUS_CONTROL } from './chat/studioDesign';
import { Button } from './ds/Button';
import { Segmented } from './ds/Segmented';
import { Skeleton } from './ds/Skeleton';
import { useComicTheme } from './comicstudio/useComicTheme';
import { SAMPLE_COVER_URL, SAMPLE_LOOKS } from './comicstudio/library/sampleArt';
import { ComicSampleReader } from './comicshost/ComicSampleReader';
import './comicshost/comicsLanding.css';
import './publicGallery.css';

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
    creatorHandle?: string;
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

type GallerySort = 'trending' | 'recent';
type SearchKind = 'title' | 'creator';
type SampleStory = 'paper-boat' | 'last-tram';
const SAMPLES = [
    { id: 'last-tram' as const, title: 'The Last Tram', note: 'One last ride through a city after dark.', image: '/assets/comic-sample/last-tram-page-1-480.webp', detail: 'A city story · 2 pages' },
    { id: 'paper-boat' as const, title: 'The Paper Boat', note: 'A small boat. A big adventure for Mira and Biscuit.', image: SAMPLE_COVER_URL, detail: 'An everyday adventure · 2 pages' }
];
const sampleFromLocation = (): SampleStory | null => {
    const value = new URLSearchParams(window.location.search).get('sample');
    return value === 'paper-boat' || value === 'last-tram' ? value : null;
};
const libraryHref = (sample?: SampleStory) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'gallery');
    url.searchParams.delete('id');
    if (sample) url.searchParams.set('sample', sample);
    else url.searchParams.delete('sample');
    url.hash = '';
    return `${url.pathname}${url.search}${url.hash}`;
};
const plainClick = (event: React.MouseEvent<HTMLAnchorElement>) =>
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
// ilike is a structured PostgREST filter; escape SQL LIKE metacharacters so the input is literal.
const literalLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const schemaMissingLikes = (error: { code?: string; message?: string }) =>
    (error.code === '42703' || error.code === 'PGRST204') && /likes_count/i.test(error.message ?? '');

async function hydratePreview(project: PublicProject): Promise<PublicProject> {
    // Never sign or display owner-writable draft images for a v4 publication.
    if (isStudioV4Project(project)) return project;
    const nextProject = structuredClone(project);
    if (!nextProject.coverImage && nextProject.state.coverImageId) {
        nextProject.coverImage = await getImageUrl(nextProject.state.coverImageId, { transform: IMAGE_TRANSFORMS.thumb });
    }
    if (Array.isArray(nextProject.state.panels)) {
        const index = nextProject.state.panels.findIndex((panel) => !panel.imageUrl && !!panel.imageId);
        if (index >= 0) {
            const panel = nextProject.state.panels[index];
            const imageUrl = await getImageUrl(panel.imageId!, { transform: IMAGE_TRANSFORMS.thumb });
            if (imageUrl) nextProject.state.panels[index] = { ...panel, imageUrl };
        }
    }
    if (Array.isArray(nextProject.state.styleVariants)) {
        const index = nextProject.state.styleVariants.findIndex((variant) => !variant.imageUrl && !!variant.imageId);
        if (index >= 0) {
            const variant = nextProject.state.styleVariants[index];
            const imageUrl = await getImageUrl(variant.imageId!, { transform: IMAGE_TRANSFORMS.thumb });
            if (imageUrl) nextProject.state.styleVariants[index] = { ...variant, imageUrl };
        }
    }
    return nextProject;
}

export const PublicGallery: React.FC<PublicGalleryProps> = ({ onReadComic, onRequireAuth }) => {
    const { user } = useAuth();
    const { theme } = useComicTheme();
    const [projects, setProjects] = useState<PublicProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [nextOffset, setNextOffset] = useState(0);
    const [filter, setFilter] = useState<GallerySort>('trending');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [searchKind, setSearchKind] = useState<SearchKind>('title');
    const [kidsOnly, setKidsOnly] = useState(false);
    const [likeBusy, setLikeBusy] = useState<Record<string, boolean>>({});
    const [likeError, setLikeError] = useState<string | null>(null);
    const [sample, setSample] = useState<SampleStory | null>(sampleFromLocation);
    const requestGeneration = useRef(0);
    const effectiveSort = useRef<'likes_count' | 'created_at'>('likes_count');
    const pageBusy = useRef(false);
    const sampleTitle = useRef<HTMLHeadingElement>(null);
    const sampleTrigger = useRef<HTMLAnchorElement | null>(null);
    const newResults = useRef<HTMLLIElement | null>(null);
    const focusNextPage = useRef(false);
    const previousLength = useRef(0);

    useEffect(() => {
        const timeout = window.setTimeout(() => setQuery(search.trim()), 300);
        return () => window.clearTimeout(timeout);
    }, [search]);

    useEffect(() => {
        const sync = () => setSample(sampleFromLocation());
        window.addEventListener('popstate', sync);
        return () => window.removeEventListener('popstate', sync);
    }, []);

    useEffect(() => {
        if (sample) sampleTitle.current?.focus({ preventScroll: true });
    }, [sample]);

    const navigateSample = (event: React.MouseEvent<HTMLAnchorElement>, story: SampleStory | null) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        if (story) sampleTrigger.current = event.currentTarget;
        window.history.pushState(window.history.state, '', libraryHref(story ?? undefined));
        setSample(story);
        if (story) window.scrollTo({ top: 0, behavior: 'instant' });
        else window.requestAnimationFrame(() => sampleTrigger.current?.focus());
    };

    const fetchPage = useCallback(async (offset: number, generation: number) => {
        if (generation !== requestGeneration.current || pageBusy.current) return;
        pageBusy.current = true;
        setError(null);
        if (offset === 0) setLoading(true);
        else setLoadingMore(true);
        try {
            let creatorIds: string[] | undefined;
            if (query && searchKind === 'creator') {
                // Handles are unique. Exact matching keeps creator discovery complete without a
                // capped partial-profile search silently excluding some creators' comics.
                const creators = await supabase.from('profiles').select('id').ilike('username', literalLike(query.replace(/^@/, ''))).limit(2);
                if (creators.error) throw creators.error;
                creatorIds = (creators.data ?? []).map((profile) => profile.id);
            }
            const cards = (order: 'likes_count' | 'created_at') => {
                let request = supabase.from('projects').select(GALLERY_CARD_SELECT)
                    .eq('is_public', true).not('is_forced_private', 'is', true);
                if (query && searchKind === 'title') request = request.ilike('name', `%${literalLike(query)}%`);
                if (creatorIds) request = request.in('user_id', creatorIds);
                if (kidsOnly) request = request.in('content_rating', ['G', 'PG']);
                // A deterministic secondary key prevents equal-score/date rows changing pages.
                return request.order(order, { ascending: false, nullsFirst: false })
                    .order('id', { ascending: true }).range(offset, offset + GALLERY_PAGE_SIZE - 1);
            };
            let result = creatorIds?.length === 0 ? { data: [], error: null } : await cards(effectiveSort.current);
            if (generation !== requestGeneration.current) return;
            if (result.error && effectiveSort.current === 'likes_count' && schemaMissingLikes(result.error)) {
                effectiveSort.current = 'created_at';
                result = await cards('created_at');
            }
            if (result.error) throw result.error;
            if (generation !== requestGeneration.current) return;
            const received = (result.data ?? []) as unknown as Record<string, unknown>[];
            const rows = received.map((row) => ({ ...row, state: galleryCardStateOf(row) }))
                .filter((row: any) => row && typeof row.id === 'string' && typeof row.name === 'string'
                    && typeof row.created_at === 'string' && typeof row.updated_at === 'string'
                    && row.is_forced_private !== true && (!kidsOnly || isKidsFriendly(gateRatingOf(row))));
            const userIds = Array.from(new Set(rows.flatMap((row: any) => typeof row.user_id === 'string' ? [row.user_id as string] : [])));
            const authorMap = new Map<string, string>();
            if (userIds.length) {
                const profiles = await supabase.from('profiles').select('id, username').in('id', userIds);
                if (!profiles.error) for (const profile of profiles.data ?? []) {
                    if (typeof profile.username === 'string' && profile.username.trim()) authorMap.set(profile.id, profile.username.trim());
                }
            }
            const mapped = rows.map((row: any): PublicProject => ({
                id: row.id, name: row.name,
                createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
                publishedAt: normalizeTimestamp(row.published_at) ?? normalizeTimestamp(row.state.publishedAt) ?? new Date(row.created_at).getTime(),
                coverImage: typeof row.cover_image_url === 'string' ? row.cover_image_url : undefined,
                state: row.state, isPublic: !!row.is_public,
                userId: typeof row.user_id === 'string' ? row.user_id : undefined,
                authorName: authorMap.get(row.user_id) || fallbackUsernameFromId(row.user_id),
                creatorHandle: authorMap.get(row.user_id),
                likesCount: typeof row.likes_count === 'number' ? row.likes_count : 0,
                viewsCount: typeof row.views_count === 'number' ? row.views_count : 0,
                contentRating: gateRatingOf(row)
            }));
            const [hydrated, likeMap] = await Promise.all([
                Promise.all(mapped.map(hydratePreview)),
                user?.id ? getProjectLikeMap(mapped.map((project) => project.id)).catch(() => ({} as Record<string, boolean>)) : Promise.resolve({} as Record<string, boolean>)
            ]);
            if (generation !== requestGeneration.current) return;
            const page = hydrated.map((project) => ({ ...project, isLiked: !!likeMap[project.id] }));
            setProjects((previous) => offset === 0 ? page : [...previous, ...page.filter((project) => !previous.some((p) => p.id === project.id))]);
            setHasMore(received.length === GALLERY_PAGE_SIZE);
            setNextOffset(offset + received.length);
        } catch {
            if (generation === requestGeneration.current) setError(offset === 0 ? 'The community Library could not be loaded.' : 'The next comics could not be loaded. Your place is saved.');
        } finally {
            if (generation === requestGeneration.current) {
                pageBusy.current = false;
                setLoading(false);
                setLoadingMore(false);
            }
        }
    }, [query, searchKind, kidsOnly, user?.id]);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        pageBusy.current = false;
        effectiveSort.current = filter === 'trending' ? 'likes_count' : 'created_at';
        setProjects([]);
        setHasMore(false);
        setNextOffset(0);
        focusNextPage.current = false;
        void fetchPage(0, generation);
        return () => { requestGeneration.current += 1; };
    }, [filter, fetchPage]);

    useEffect(() => {
        if (!loadingMore && focusNextPage.current && projects.length > previousLength.current) {
            newResults.current?.querySelector<HTMLAnchorElement>('a')?.focus();
            focusNextPage.current = false;
        }
    }, [projects, loadingMore]);

    const loadMore = () => {
        previousLength.current = projects.length;
        focusNextPage.current = true;
        void fetchPage(nextOffset, requestGeneration.current);
    };
    const clearFilters = () => { setSearch(''); setQuery(''); setKidsOnly(false); };
    const filteredProjects = projects.filter((project) => !kidsOnly || isKidsFriendly(project.contentRating));
    const isSearching = search.trim() !== query;
    const showSamples = !query && !search.trim() && !kidsOnly;

    const toggleLike = async (project: PublicProject) => {
        if (!user) { onRequireAuth?.(); return; }
        if (likeBusy[project.id]) return;
        setLikeError(null);
        setLikeBusy((previous) => ({ ...previous, [project.id]: true }));
        const currentLiked = !!project.isLiked;
        const originalCount = project.likesCount || 0;
        setProjects((previous) => previous.map((p) => p.id === project.id ? { ...p, isLiked: !currentLiked, likesCount: Math.max(0, originalCount + (currentLiked ? -1 : 1)) } : p));
        try {
            const result = await toggleProjectLike(project.id, project.userId);
            setProjects((previous) => previous.map((p) => p.id === project.id ? { ...p, isLiked: result.liked, likesCount: Math.max(0, originalCount + (result.liked === currentLiked ? 0 : result.liked ? 1 : -1)) } : p));
        } catch {
            setProjects((previous) => previous.map((p) => p.id === project.id ? { ...p, isLiked: currentLiked, likesCount: originalCount } : p));
            setLikeError(`Your like for “${project.name}” could not be saved. Please try again.`);
        } finally {
            setLikeBusy((previous) => ({ ...previous, [project.id]: false }));
        }
    };

    return (
        <div data-comics-library="" data-comic-theme={theme} className="comics-library">
            <div className="comics-shell-width library-content">
                {sample && (
                    <section aria-labelledby="library-sample-title" className="library-reader">
                        <a className={cn('library-back', FOCUS_RING)} href={libraryHref()} onClick={(event) => navigateSample(event, null)}><ArrowLeft aria-hidden /> Back to Library</a>
                        <div className="library-reader-heading">
                            <p className="library-eyebrow">Studio sample · 2 pages</p>
                            <h1 id="library-sample-title" ref={sampleTitle} tabIndex={-1}>{SAMPLES.find((story) => story.id === sample)?.title}</h1>
                            <p>Read at your own pace. Use the arrows or swipe to turn the page.</p>
                        </div>
                        <ComicSampleReader key={sample} look={SAMPLE_LOOKS[0]} standalone story={sample} />
                        <a className={cn('library-back', FOCUS_RING)} href={libraryHref()} onClick={(event) => navigateSample(event, null)}><ArrowLeft aria-hidden /> Find your next read</a>
                    </section>
                )}
                <div hidden={!!sample}>
                    <header className="library-heading">
                        <div><p className="library-eyebrow">The reading room</p><h1>Library</h1><p>Small stories. New worlds. Find your next read.</p></div>
                        <p className="library-reading-note"><BookOpen aria-hidden /> Free to read. No account needed.</p>
                    </header>
                    {showSamples && (
                        <section aria-labelledby="library-samples-title" className="library-samples">
                            <div className="library-section-heading"><h2 id="library-samples-title">Start with a story</h2><span>From Comic Studio</span></div>
                            <div className="library-sample-grid">
                                {SAMPLES.map((story) => (
                                    <a key={story.id} href={libraryHref(story.id)} onClick={(event) => navigateSample(event, story.id)} className={cn('library-sample-card', FOCUS_RING)} aria-label={`Read ${story.title}`}>
                                        <div className="library-sample-image" data-story={story.id}><img src={story.image} alt="" width={story.id === 'paper-boat' ? 768 : 480} height={story.id === 'paper-boat' ? 1152 : 384} decoding="async" /></div>
                                        <div className="library-sample-copy"><p className="library-eyebrow">Sample comic</p><h3>{story.title}</h3><p className="library-sample-note">{story.note}</p><p className="library-sample-detail">{story.detail}</p><span className="library-read-link">Read the story <ArrowRight aria-hidden /></span></div>
                                    </a>
                                ))}
                            </div>
                        </section>
                    )}
                    <section aria-labelledby="library-community-title" className="library-community" aria-busy={loading || isSearching || loadingMore}>
                        <div className="library-section-heading"><h2 id="library-community-title">From the community</h2>{!user && onRequireAuth && <Button type="button" variant="outline" size="sm" onClick={onRequireAuth}>Sign in</Button>}</div>
                        <form role="search" className="library-search-form" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}>
                            <label className="library-search-kind"><span className="sr-only">Search by</span><select value={searchKind} onChange={(event) => setSearchKind(event.target.value as SearchKind)}><option value="title">Comic title</option><option value="creator">Creator</option></select></label>
                            <label className="library-search-field"><Search aria-hidden /><span className="sr-only">{searchKind === 'title' ? 'Search comic titles' : 'Search creator username'}</span><input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder={searchKind === 'title' ? 'Search comic titles' : 'Enter a creator’s exact username'} aria-describedby="library-search-help" /></label>
                            {search && <button type="button" className={cn('library-clear-search', FOCUS_RING)} aria-label="Clear search" onClick={() => { setSearch(''); setQuery(''); }}><X aria-hidden /></button>}
                            <Button type="submit" variant="outline" className="library-search-submit">Search</Button>
                        </form>
                        <div className="library-toolbar">
                            <Segmented<GallerySort> className="library-sort" label="Sort the Library" value={filter} onChange={setFilter} options={[{ value: 'trending', label: 'Trending' }, { value: 'recent', label: 'Recent' }]} />
                            <Button type="button" variant="outline" aria-pressed={kidsOnly} onClick={() => setKidsOnly((value) => !value)} title="Only published comics rated G or PG by the publish check" className="library-kids">{kidsOnly ? <Check aria-hidden /> : <Baby aria-hidden />} Kids-friendly (G/PG)</Button>
                            {(query || kidsOnly) && <button type="button" className={cn('library-reset', FOCUS_RING)} onClick={clearFilters}>Clear filters</button>}
                        </div>
                        <p id="library-search-help" className="library-search-help">{searchKind === 'creator' ? 'Search an exact username, with or without @.' : 'Search titles across the community Library.'}{kidsOnly && ' Only published comics rated G or PG are included.'}</p>
                        <p className="library-results-count" role="status" aria-live="polite">{loading || isSearching ? 'Finding your next read…' : error && projects.length === 0 ? 'Community comics are temporarily unavailable.' : `${filteredProjects.length} ${filteredProjects.length === 1 ? 'comic' : 'comics'}${query ? ` for “${query}”` : ''}${hasMore ? ' shown · more to discover' : ''}`}</p>
                        {likeError && <p className="library-inline-error" role="alert">{likeError}</p>}
                        {loading ? (
                            <div aria-label="Loading the Library" className="library-grid" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div key={index}><Skeleton className="library-cover" /><Skeleton shape="text" className="mt-3 w-3/4" /><Skeleton shape="text" className="mt-2 w-1/2" /></div>)}</div>
                        ) : (
                            <>
                                {filteredProjects.length > 0 && <ul className="library-grid">
                                    {filteredProjects.map((project, index) => {
                                        const covers = coverCandidates(project);
                                        const slug = shareSlugOf(project);
                                        const likeLabel = user ? (project.isLiked ? 'Unlike' : 'Like') : 'Sign in to like';
                                        return <li key={project.id} ref={index === previousLength.current ? newResults : undefined} data-testid="gallery-card" data-share-slug={slug} className="library-card">
                                            <a href={slug ? SHARE_PATH(slug) : `/?view=read&id=${encodeURIComponent(project.id)}`} aria-label={`Read ${project.name}`} className={cn('library-card-read', FOCUS_RING)} onClick={slug ? undefined : (event) => { if (plainClick(event)) { event.preventDefault(); onReadComic(project.id); } }}>
                                                <div className="library-cover"><SmartImage src={covers[0]} fallbackSources={covers.slice(1)} alt="" className="h-full w-full object-cover" containerClassName="w-full h-full" fallbackIcon={<BookOpen aria-hidden className="size-10" />} />{project.contentRating && <div className="library-rating"><RatingBadge rating={project.contentRating} onArt /></div>}<span className="library-cover-read" aria-hidden>Read comic <ArrowRight /></span></div>
                                                <h3>{project.name}</h3>
                                            </a>
                                            {project.creatorHandle ? <button type="button" className={cn('library-creator', FOCUS_RING)} onClick={() => { setSearchKind('creator'); setSearch(project.creatorHandle!); setQuery(project.creatorHandle!); }}>by {project.creatorHandle}</button> : <p className="library-creator">by {project.authorName || 'Unknown creator'}</p>}
                                            <p className="library-published">{new Date(project.publishedAt || project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                                            <div className="library-card-stats"><button type="button" onClick={() => void toggleLike(project)} aria-pressed={user ? !!project.isLiked : undefined} aria-label={`${likeLabel} ${project.name}, ${project.likesCount || 0} likes`} disabled={!!likeBusy[project.id] || (!user && !onRequireAuth)} className={cn('library-like', RADIUS_CONTROL, FOCUS_RING)}><Heart aria-hidden className={project.isLiked ? 'fill-current' : undefined} />{project.likesCount || 0}</button><span><Eye aria-hidden /><span className="sr-only">Views: </span>{project.viewsCount || 0}</span></div>
                                        </li>;
                                    })}
                                </ul>}
                                {!error && filteredProjects.length === 0 && <div className="library-empty"><BookOpen aria-hidden /><h3>{hasMore ? 'Keep exploring the Library.' : query ? 'No matching comics.' : kidsOnly ? 'No kids-friendly comics yet.' : 'The next story could be yours.'}</h3><p>{hasMore ? 'No readable comics appeared in this batch. Load the next comics below.' : query ? 'Try another title or an exact creator username.' : kidsOnly ? 'Only published comics rated G or PG show here.' : 'Community comics will appear here when creators publish them. In the meantime, enjoy a Studio sample above.'}</p>{(query || kidsOnly) && <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}</div>}
                                {error && <div role="alert" className="library-load-error"><p>{error}</p><p>{showSamples ? 'Studio samples are still available above.' : 'Check your connection and try again.'}</p><Button variant="outline" onClick={() => void fetchPage(projects.length ? nextOffset : 0, requestGeneration.current)}>Try again</Button></div>}
                                {hasMore && !error && <div className="library-more"><Button type="button" variant="outline" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading more comics…' : 'Load more comics'}{!loadingMore && <ArrowRight aria-hidden />}</Button><p>Showing {filteredProjects.length} comics. Keep exploring at your own pace.</p></div>}
                            </>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
};

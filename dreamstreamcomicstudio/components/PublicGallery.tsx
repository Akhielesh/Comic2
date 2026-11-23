import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { clearLibraryReads, libraryHistoryKey, libraryPicks, libraryReads, LIBRARY_HISTORY_CHANGED, type DiscoveryComic } from '../services/libraryDiscovery';
import { filterPublicListing, isPubliclyListed } from '../services/publicListing';
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
    /** Asked when a signed-in-only action is attempted without an account (kept for its callers; visitors see no such action). */
    onRequireAuth?: () => void;
}

interface PublicProject extends Project {
    average_rating?: number;
    review_count?: number;
    isLiked?: boolean;
    /** The rating the publish gate assigned (projects.content_rating, server-set). */
    contentRating?: ContentRating;
    publicOverview?: string;
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

type GallerySort = 'discovery' | 'trending' | 'recent';
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
// Only schema failures may fall back to creation-date ordering; network failures stay retryable.
const isMissingGalleryColumn = (failure: { code?: string }) =>
    failure.code === '42703' || failure.code === 'PGRST204';
/**
 * Search, sort and the Kids-friendly filter appear only once the Library holds more than this many comics:
 * with a handful, every comic is already on screen and the tools would only add clutter.
 */
export const LIBRARY_TOOLS_MIN = 6;
/**
 * With this many comics or fewer (and no tools, filter or further pages) a cover grid would leave most of its row
 * empty, so each comic is a wide card instead: the cover beside its title, date and a read link, the shape of the
 * Studio samples below it.
 */
export const LIBRARY_FEW_MAX = 2;

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

const DISCOVERY_SELECT = GALLERY_CARD_SELECT + ',publishedOverview:state->overview';

function publicCards(received: Record<string, unknown>[], kidsOnly = false): PublicProject[] {
    // The same rule again on the client (a backstop), then the card's own shape checks.
    const rows = received.map((row) => ({ ...row, state: galleryCardStateOf(row) }))
        .filter((row: any) => row && typeof row.id === 'string' && typeof row.name === 'string'
            && typeof row.created_at === 'string' && typeof row.updated_at === 'string'
            && isPubliclyListed(row) && (!kidsOnly || isKidsFriendly(gateRatingOf(row))));
    // No maker name on a card: profiles are readable by their owner only, and a publication's "show my
    // name" choice is not on the listing row, so a name here would be wrong or a stand-in id.
    return rows.map((row: any): PublicProject => ({
        id: row.id, name: row.name,
        publicOverview: typeof row.publishedOverview === 'string' ? row.publishedOverview.slice(0,600) : '',
        createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
        publishedAt: normalizeTimestamp(row.published_at) ?? normalizeTimestamp(row.state.publishedAt) ?? new Date(row.created_at).getTime(),
        coverImage: typeof row.cover_image_url === 'string' ? row.cover_image_url : undefined,
        state: row.state, isPublic: !!row.is_public,
        userId: typeof row.user_id === 'string' ? row.user_id : undefined,
        likesCount: typeof row.likes_count === 'number' ? row.likes_count : 0,
        viewsCount: typeof row.views_count === 'number' ? row.views_count : 0,
        contentRating: gateRatingOf(row)
    }));
}

function discoveryComic(project: PublicProject): DiscoveryComic | null {
    const slug = shareSlugOf(project);
    return slug ? {slug, title:project.name, overview:project.publicOverview ?? '', owner:project.userId,
        rating:project.contentRating, likes:project.likesCount ?? 0, publishedAt:project.publishedAt || project.createdAt,
        liked:!!project.isLiked} : null;
}

export const PublicGallery: React.FC<PublicGalleryProps> = ({ onReadComic, onRequireAuth }) => {
    const { user, loading: authLoading } = useAuth();
    const owner = user?.id ?? null;
    const [historyVersion, setHistoryVersion] = useState(0);
    const reads = useMemo(() => authLoading ? [] : libraryReads(owner), [authLoading, owner, historyVersion]);
    useEffect(() => {
        const reload = () => setHistoryVersion(n => n+1);
        const storageChanged = (e: StorageEvent) => { if (!e.key || e.key === libraryHistoryKey(owner)) reload(); };
        window.addEventListener('pageshow', reload);
        window.addEventListener('storage', storageChanged);
        window.addEventListener(LIBRARY_HISTORY_CHANGED, reload);
        return () => {
            window.removeEventListener('pageshow', reload);
            window.removeEventListener('storage', storageChanged);
            window.removeEventListener(LIBRARY_HISTORY_CHANGED, reload);
        };
    }, [owner]);
    const { theme } = useComicTheme();
    const [projects, setProjects] = useState<PublicProject[]>([]);
    const [listingOwner, setListingOwner] = useState<string | null | undefined>(undefined);
    const [earlierReading, setEarlierReading] = useState<PublicProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadNotice, setLoadNotice] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [nextOffset, setNextOffset] = useState(0);
    const [filter, setFilter] = useState<GallerySort>('discovery');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [kidsOnly, setKidsOnly] = useState(false);
    const [likeBusy, setLikeBusy] = useState<Record<string, boolean>>({});
    const [likeError, setLikeError] = useState<string | null>(null);
    const [sample, setSample] = useState<SampleStory | null>(sampleFromLocation);
    /** Comics the current view lists in all (the database's count less any the client dropped); null until known. */
    const [total, setTotal] = useState<number | null>(null);
    /** Comics the whole Library lists (no search, no filter); null until the first unfiltered page arrives. */
    const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
    const dropped = useRef(0);
    const requestGeneration = useRef(0);
    const effectiveSort = useRef<'likes_count' | 'created_at'>('likes_count');
    const pageBusy = useRef(false);
    const sampleTitle = useRef<HTMLHeadingElement>(null);
    const libraryTitle = useRef<HTMLHeadingElement>(null);
    const previousSample = useRef<SampleStory | null>(null);
    const sampleReturnScroll = useRef(0);
    const sampleTrigger = useRef<HTMLAnchorElement | null>(null);
    const newResults = useRef<HTMLLIElement | null>(null);
    const focusNextPage = useRef(false);
    const previousLength = useRef(0);
    const nextFocusId = useRef<string | undefined>(undefined);

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
        if (sample) {
            previousSample.current = sample;
            sampleTitle.current?.focus({ preventScroll: true });
        } else if (previousSample.current) {
            previousSample.current = null;
            const frame = window.requestAnimationFrame(() => {
                (sampleTrigger.current ?? libraryTitle.current)?.focus({ preventScroll: true });
                window.scrollTo({ top: sampleReturnScroll.current, behavior: 'instant' });
            });
            return () => window.cancelAnimationFrame(frame);
        }
    }, [sample]);

    const navigateSample = (event: React.MouseEvent<HTMLAnchorElement>, story: SampleStory | null) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        if (story) {
            sampleTrigger.current = event.currentTarget;
            sampleReturnScroll.current = window.scrollY;
        }
        window.history.pushState(window.history.state, '', libraryHref(story ?? undefined));
        setSample(story);
        if (story) window.scrollTo({ top: 0, behavior: 'instant' });
    };

    const fetchPage = useCallback(async (offset: number, generation: number) => {
        if (generation !== requestGeneration.current || pageBusy.current) return;
        pageBusy.current = true;
        setLoadNotice(null);
        if (offset === 0) setLoading(true);
        else setLoadingMore(true);
        try {
            const cards = (order: 'likes_count' | 'created_at') => {
                // The listing rule (services/publicListing.ts) runs in the database: hidden comics never download.
                // The first page also asks for the count, so "N comics" counts every listed comic, not one page.
                let request = filterPublicListing(supabase.from('projects').select(DISCOVERY_SELECT, offset === 0 ? { count: 'exact' } : undefined));
                if (query) request = request.ilike('name', `%${literalLike(query)}%`);
                if (kidsOnly) request = request.in('content_rating', ['G', 'PG']);
                // A deterministic secondary key prevents equal-score/date rows changing pages.
                return request.order(order, { ascending: false, nullsFirst: false })
                    .order('id', { ascending: true }).range(offset, offset + GALLERY_PAGE_SIZE - 1);
            };
            let result = await cards(effectiveSort.current);
            if (generation !== requestGeneration.current) return;
            if (result.error && effectiveSort.current === 'likes_count' && isMissingGalleryColumn(result.error)) {
                effectiveSort.current = 'created_at';
                result = await cards('created_at');
            }
            if (result.error) throw result.error;
            if (generation !== requestGeneration.current) return;
            const received = (result.data ?? []) as unknown as Record<string, unknown>[];
            const mapped = publicCards(received, kidsOnly);
            const [hydrated, likeMap] = await Promise.all([
                Promise.all(mapped.map(hydratePreview)),
                user?.id ? getProjectLikeMap(mapped.map((project) => project.id), owner ?? undefined).catch(() => ({} as Record<string, boolean>)) : Promise.resolve({} as Record<string, boolean>)
            ]);
            if (generation !== requestGeneration.current) return;
            setListingOwner(owner);
            if (offset > 0) nextFocusId.current = mapped[0]?.id;
            const page = hydrated.map((project) => ({ ...project, isLiked: !!likeMap[project.id] }));
            setProjects((previous) => offset === 0 ? page : [...previous, ...page.filter((project) => !previous.some((p) => p.id === project.id))]);
            setHasMore(received.length === GALLERY_PAGE_SIZE);
            setNextOffset(offset + received.length);
            if (offset === 0) dropped.current = 0;
            dropped.current += received.length - mapped.length;
            const counted = typeof (result as { count?: unknown }).count === 'number' ? (result as { count: number }).count : null;
            const listed = offset === 0
                ? (counted !== null ? Math.max(mapped.length, counted - dropped.current) : received.length < GALLERY_PAGE_SIZE ? mapped.length : null)
                : undefined;
            if (listed !== undefined) {
                setTotal(listed);
                if (!query && !kidsOnly && listed !== null) setLibraryTotal(listed);
            } else setTotal((previous) => previous === null ? null : Math.max(0, previous - (received.length - mapped.length)));
        } catch {
            if (generation === requestGeneration.current) setLoadNotice(offset === 0 ? 'The Library could not be loaded.' : 'The next comics could not be loaded. Your place is saved.');
        } finally {
            if (generation === requestGeneration.current) {
                pageBusy.current = false;
                setLoading(false);
                setLoadingMore(false);
            }
        }
    }, [query, kidsOnly, user?.id]);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        pageBusy.current = false;
        setLikeError(null);
        setLikeBusy({});
        effectiveSort.current = filter === 'recent' ? 'created_at' : 'likes_count';
        setProjects([]);
        setHasMore(false);
        setNextOffset(0);
        setTotal(null);
        focusNextPage.current = false;
        void fetchPage(0, generation);
        return () => { requestGeneration.current += 1; };
    }, [filter, fetchPage]);

    // Older reads may no longer be on the first grid page. Revalidate their slugs through exactly
    // the public listing query; local history never supplies a title, cover or private capability.
    useEffect(() => {
        let cancelled = false;
        setEarlierReading([]);
        if (filter !== 'discovery' || query || kidsOnly || !hasMore || (!reads.length && !owner) || listingOwner !== owner) return;
        const missing = reads.map(row => row.slug).filter(slug => !projects.some(project => shareSlugOf(project) === slug));
        void (async () => {
            const publicSeedCards = async (column: 'id' | 'state->>shareSlug', values: string[]) => {
                if (!values.length) return [];
                const { data, error } = await filterPublicListing(supabase.from('projects').select(DISCOVERY_SELECT))
                    .in(column, values).limit(values.length);
                return !error && data ? publicCards(data as unknown as Record<string,unknown>[]) : [];
            };
            try {
                const memberLikes = async () => {
                    if (!owner) return [];
                    const { data } = await supabase.from('project_likes').select('project_id').eq('user_id',owner)
                        .order('created_at',{ascending:false}).limit(12);
                    const ids = (data ?? []).map(row => row.project_id).filter((id): id is string =>
                        typeof id === 'string' && !projects.some(project => project.id === id));
                    return (await publicSeedCards('id',ids)).map(card => ({...card,isLiked:true}));
                };
                const [pastReads, pastLikes] = await Promise.all([publicSeedCards('state->>shareSlug',missing), memberLikes()]);
                if (!cancelled) setEarlierReading([...pastLikes,...pastReads]);
            } catch { /* The rest of the Library stays available. */ }
        })();
        return () => { cancelled = true; };
    }, [filter,query,kidsOnly,hasMore,reads,projects,owner,listingOwner]);

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
    const discoveryActive = filter === 'discovery' && !query && !search.trim() && !kidsOnly && !authLoading && listingOwner === owner;
    const ranked = useMemo(() => {
        if (!discoveryActive) return [];
        const toComic = (rows: PublicProject[]) => rows.map(discoveryComic).filter((c): c is DiscoveryComic => !!c);
        return libraryPicks(toComic(projects.slice(0,GALLERY_PAGE_SIZE)),reads,toComic(earlierReading));
    }, [discoveryActive,projects,reads,earlierReading]);
    const picks = new Map(ranked.map(pick => [pick.slug,pick]));
    const catalog = new Map([...earlierReading,...projects].map(project => [shareSlugOf(project),project]));
    const visibleProjects = listingOwner === owner ? projects : [];
    const rankedProjects = ranked.flatMap(pick => catalog.get(pick.slug) ?? []);
    const filteredProjects = [...rankedProjects,...visibleProjects.filter(project => !picks.has(shareSlugOf(project) ?? ''))]
      .filter(project => !kidsOnly || isKidsFriendly(project.contentRating));
    const isSearching = search.trim() !== query;
    const filtering = !!query || !!search.trim() || kidsOnly;
    const showSamples = !filtering;
    // A small Library shows its comics and nothing else: no search box, sort or filter until it has enough
    // comics for them to help (and never while the size is unknown, so the tools do not flash in and out).
    const showTools = filtering || (libraryTotal !== null && libraryTotal > LIBRARY_TOOLS_MIN);
    // An empty Library shows no comics section at all (no empty shelf, no "0 comics"): the samples stay.
    const showComics = loading || loadingMore || filtering || hasMore || !!loadNotice || filteredProjects.length > 0;
    const shownCount = total ?? filteredProjects.length;
    const few = !showTools && !hasMore && filteredProjects.length > 0 && filteredProjects.length <= LIBRARY_FEW_MAX;
    const countText = loading || isSearching ? 'Finding your next read…'
        : loadNotice && projects.length === 0 ? 'Comics are temporarily unavailable.'
        : `${shownCount} ${shownCount === 1 ? 'comic' : 'comics'}${query ? ` for “${query}”` : ''}`;

    const toggleLike = async (project: PublicProject) => {
        if (!user) { onRequireAuth?.(); return; }
        if (likeBusy[project.id]) return;
        const generation = requestGeneration.current;
        setLikeError(null);
        setLikeBusy((previous) => ({ ...previous, [project.id]: true }));
        const currentLiked = !!project.isLiked;
        const originalCount = project.likesCount || 0;
        setProjects((previous) => previous.map((p) => p.id === project.id ? { ...p, isLiked: !currentLiked, likesCount: Math.max(0, originalCount + (currentLiked ? -1 : 1)) } : p));
        try {
            const result = await toggleProjectLike(project.id, project.userId, user.id);
            if (generation !== requestGeneration.current) return;
            setProjects((previous) => previous.map((p) => p.id === project.id ? { ...p, isLiked: result.liked, likesCount: Math.max(0, originalCount + (result.liked === currentLiked ? 0 : result.liked ? 1 : -1)) } : p));
        } catch {
            if (generation !== requestGeneration.current) return;
            setProjects((previous) => previous.map((p) => p.id === project.id ? { ...p, isLiked: currentLiked, likesCount: originalCount } : p));
            setLikeError(`Your like for “${project.name}” could not be saved. Please try again.`);
        } finally {
            setLikeBusy((previous) => ({ ...previous, [project.id]: false }));
        }
    };

    const comicsSection = showComics && (
        <section aria-labelledby="library-community-title" className="library-community" aria-busy={loading || isSearching || loadingMore}>
            <div className="library-section-heading"><h2 id="library-community-title">{showTools && discoveryActive ? 'Find your next read' : 'New comics'}</h2>
                {discoveryActive && reads.length > 0 ? <button type="button" className={cn('library-reset',FOCUS_RING)} onClick={() => clearLibraryReads(owner)}>Clear reading history</button> : <span>Made in Comic Studio</span>}</div>
            {showTools && <>
                <form role="search" className="library-search-form" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}>
                    <label className="library-search-field"><Search aria-hidden /><span className="sr-only">Search comic titles</span><input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="Search comic titles" /></label>
                    {search && <button type="button" className={cn('library-clear-search', FOCUS_RING)} aria-label="Clear search" onClick={() => { setSearch(''); setQuery(''); }}><X aria-hidden /></button>}
                    <Button type="submit" variant="outline" className="library-search-submit">Search</Button>
                </form>
                <div className="library-toolbar">
                    <Segmented<GallerySort> className="library-sort" label="Sort the Library" value={filter} onChange={setFilter} options={[{ value: 'discovery', label: 'Discover' }, { value: 'trending', label: 'Trending' }, { value: 'recent', label: 'Recent' }]} />
                    <Button type="button" variant="outline" aria-pressed={kidsOnly} onClick={() => setKidsOnly((value) => !value)} title="Only published comics rated G or PG by the publish check" className="library-kids">{kidsOnly ? <Check aria-hidden /> : <Baby aria-hidden />} Kids-friendly (G/PG)</Button>
                    {(query || kidsOnly) && <button type="button" className={cn('library-reset', FOCUS_RING)} onClick={clearFilters}>Clear filters</button>}
                </div>
            </>}
            <p className={cn('library-results-count', !showTools && 'sr-only')} role="status" aria-live="polite">{countText}</p>
            {likeError && <p className="library-inline-error" role="alert">{likeError}</p>}
            {loading ? (
                <div aria-label="Loading the Library" className="library-grid" aria-busy="true">{Array.from({ length: showTools ? 8 : 2 }, (_, index) => <div key={index}><Skeleton className="library-cover" /><Skeleton shape="text" className="mt-3 w-3/4" /><Skeleton shape="text" className="mt-2 w-1/2" /></div>)}</div>
            ) : (
                <>
                    {filteredProjects.length > 0 && <ul className="library-grid" data-layout={few ? 'few' : undefined}>
                        {filteredProjects.map((project) => {
                            const covers = coverCandidates(project);
                            const slug = shareSlugOf(project);
                            const pick = slug ? picks.get(slug) : undefined;
                            const resume = pick?.resumePage;
                            const why = pick?.reason && (showTools || resume || pick.reason.startsWith('Because you')) ? pick.reason : '';
                            const likes = project.likesCount || 0;
                            const cover = <div className="library-cover"><SmartImage src={covers[0]} fallbackSources={covers.slice(1)} alt="" className="h-full w-full object-cover" containerClassName="w-full h-full" fallbackIcon={<BookOpen aria-hidden className="size-10" />} />{project.contentRating && <div className="library-rating"><RatingBadge rating={project.contentRating} onArt /></div>}{!few && <span className="library-cover-read" aria-hidden>{resume ? 'Continue reading' : 'Read comic'} <ArrowRight /></span>}</div>;
                            const published = <p className="library-published">{new Date(project.publishedAt || project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p>;
                            // A wide card keeps one link (cover, title, date and "Read comic"); the likes sit beside it, outside the link.
                            return <li key={project.id} ref={project.id === nextFocusId.current ? newResults : undefined} data-testid="gallery-card" data-share-slug={slug} data-layout={few ? 'wide' : undefined} className="library-card">
                                <a href={slug ? SHARE_PATH(slug)+(resume ? '?p='+resume : '') : `/?view=read&id=${encodeURIComponent(project.id)}`} aria-label={resume ? `Continue ${project.name} from page ${resume}` : `Read ${project.name}`} className={cn('library-card-read', FOCUS_RING)} onClick={slug ? undefined : (event) => { if (plainClick(event)) { event.preventDefault(); onReadComic(project.id); } }}>
                                    {cover}
                                    {few
                                        ? <div className="library-wide-copy"><h3>{project.name}</h3>{why && <p className="library-discovery-reason">{why}</p>}{published}<span className="library-read-link" aria-hidden>{resume ? 'Continue reading' : 'Read comic'} <ArrowRight /></span></div>
                                        : <h3>{project.name}</h3>}
                                </a>
                                {why && !few && <p className="library-discovery-reason">{why}</p>}
                                {pick && !few && project.publicOverview && <p className="library-discovery-summary">{project.publicOverview}</p>}
                                {!few && published}
                                <div className="library-card-stats">
                                    {/* Reading needs no account: a visitor sees the likes, a signed-in reader can add one. */}
                                    {user
                                        ? <button type="button" onClick={() => void toggleLike(project)} aria-pressed={!!project.isLiked} aria-label={`${project.isLiked ? 'Unlike' : 'Like'} ${project.name}, ${likes} likes`} disabled={!!likeBusy[project.id]} className={cn('library-like', RADIUS_CONTROL, FOCUS_RING)}><Heart aria-hidden className={project.isLiked ? 'fill-current' : undefined} />{likes}</button>
                                        : <span><Heart aria-hidden /><span className="sr-only">Likes: </span>{likes}</span>}
                                    {/* A current-studio comic's reads are counted with its publication, not on this row (whose count stays
                                        0), so a zero is left out rather than shown as if nobody had read it. */}
                                    {(project.viewsCount || 0) > 0 && <span><Eye aria-hidden /><span className="sr-only">Views: </span>{project.viewsCount}</span>}
                                </div>
                            </li>;
                        })}
                    </ul>}
                    {!loadNotice && filteredProjects.length === 0 && <div className="library-empty"><BookOpen aria-hidden /><h3>{hasMore ? 'Keep exploring the Library.' : query ? 'No matching comics.' : 'No kids-friendly comics yet.'}</h3><p>{hasMore ? 'No readable comics appeared in this batch. Load the next comics below.' : query ? 'Try another title.' : 'Only published comics rated G or PG show here.'}</p>{(query || kidsOnly) && <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}</div>}
                    {loadNotice && <div role="alert" className="library-load-error"><p className="[overflow-wrap:anywhere]">{loadNotice}</p><p>{showSamples ? 'Studio samples are still available below.' : 'Check your connection and try again.'}</p><Button variant="outline" onClick={() => void fetchPage(nextOffset, requestGeneration.current)}>Try again</Button></div>}
                    {hasMore && !loadNotice && <div className="library-more"><Button type="button" variant="outline" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading more comics…' : 'Load more comics'}{!loadingMore && <ArrowRight aria-hidden />}</Button><p>Showing {filteredProjects.length} of {shownCount} comics.</p></div>}
                </>
            )}
        </section>
    );

    return (
        <main data-comics-library="" data-comic-theme={theme} className="comics-library">
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
                        <h1 ref={libraryTitle} tabIndex={-1}>Library</h1>
                        <p className="library-reading-note"><BookOpen aria-hidden /> Free to read. No account needed.</p>
                    </header>
                    {comicsSection}
                    {showSamples && (
                        <section aria-labelledby="library-samples-title" className="library-samples">
                            <div className="library-section-heading"><h2 id="library-samples-title">Studio samples</h2><span>Two short stories to try the reader</span></div>
                            <div className="library-sample-grid">
                                {SAMPLES.map((story) => (
                                    <a key={story.id} href={libraryHref(story.id)} onClick={(event) => navigateSample(event, story.id)} className={cn('library-sample-card', FOCUS_RING)} aria-label={`Read ${story.title}`}>
                                        <div className="library-sample-image" data-story={story.id}><img src={story.image} srcSet={story.id === 'last-tram' ? '/assets/comic-sample/last-tram-page-1-480.webp 480w, /assets/comic-sample/last-tram-page-1-768.webp 768w, /assets/comic-sample/last-tram-page-1-1200.webp 1200w' : undefined} sizes={story.id === 'last-tram' ? '(max-width: 639px) 44vw, 24vw' : undefined} alt="" width={story.id === 'paper-boat' ? 768 : 480} height={story.id === 'paper-boat' ? 1152 : 384} decoding="async" /></div>
                                        <div className="library-sample-copy"><h3>{story.title}</h3><p className="library-sample-note">{story.note}</p><p className="library-sample-detail">{story.detail}</p><span className="library-read-link">Read the story <ArrowRight aria-hidden /></span></div>
                                    </a>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </main>
    );
};

import React, { useEffect, useState } from 'react';
import { UserProfile, Project } from '../types';
import { getImageUrl, getProfileByUsername, getPublicProjectsByUser, isFollowing, followUser, unfollowUser, getFollowersCount } from '../services/db';
import { UserAvatar } from './UserAvatar';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ds';
import { cn } from '../lib/utils';
import { CANVAS_BG, FOCUS_RING, HEADING, LIFT, MUTED, OVERLINE, RADIUS_PANEL, RADIUS_PILL, SCRIM, SECTION_CARD, SHADOW_SOFT, TEXT_2XL, TEXT_3XL } from './chat/studioDesign';
import { UserPlus, UserCheck, Grid, Heart, Eye, BookOpen } from 'lucide-react';
import { IMAGE_TRANSFORMS } from '../services/projectStorage';
import { isStudioV4Project } from '../services/studioDeepLink';
import { SHARE_PATH } from '../shared/comic/publication';
import { publicCoverUrl, shareSlugOf } from './PublicGallery';
import { RatingBadge } from './comicstudio/safety/RatingBadge';
import { SmartImage } from './common/SmartImage';

/**
 * Cover candidates: stored cover → first rendered page → first style board.
 * Same rule as the public gallery (S4): a Comic Studio (v4) comic shows ONLY its public cover — the
 * frozen, safety-cleared pub/ copy the publish gate made. Its classic cover fields are the owner's to
 * write and never went through the gate (a private draft can be re-skinned, then published), so
 * without a public cover the card shows the book icon rather than one of them.
 */
export const coverCandidates = (project: Project): string[] => {
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


interface PublicProfileProps {
    username: string; // Passed from router
    onNavigate: (view: string, projectId?: string) => void;
}

export const PublicProfile: React.FC<PublicProfileProps> = ({ username, onNavigate }) => {
    const { user: currentUser } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [following, setFollowing] = useState(false);
    const [followersCount, setFollowersCount] = useState(0);
    const [actionLoading, setActionLoading] = useState(false);

    useEffect(() => {
        loadData();
    }, [username]);

    const hydratePreview = async (project: Project): Promise<Project> => {
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
                const panelPreview = panel.imageId
                    ? await getImageUrl(panel.imageId, { transform: IMAGE_TRANSFORMS.thumb })
                    : undefined;
                if (panelPreview) {
                    nextProject.state.panels[index] = { ...panel, imageUrl: panelPreview };
                }
            }
        }

        if (Array.isArray(nextProject.state.styleVariants)) {
            const index = nextProject.state.styleVariants.findIndex((variant) => !variant.imageUrl && !!variant.imageId);
            if (index >= 0) {
                const variant = nextProject.state.styleVariants[index];
                const variantPreview = variant.imageId
                    ? await getImageUrl(variant.imageId, { transform: IMAGE_TRANSFORMS.thumb })
                    : undefined;
                if (variantPreview) {
                    nextProject.state.styleVariants[index] = { ...variant, imageUrl: variantPreview };
                }
            }
        }

        return {
            ...nextProject,
            coverImage
        };
    };

    const loadData = async () => {
        setLoading(true);
        const p = await getProfileByUsername(username);
        if (p) {
            setProfile(p);
            const projs = await getPublicProjectsByUser(p.id);
            const hydratedProjects = await Promise.all(projs.map(hydratePreview));
            setProjects(hydratedProjects);

            const count = await getFollowersCount(p.id);
            setFollowersCount(count);

            if (currentUser && currentUser.id !== p.id) {
                const isF = await isFollowing(p.id);
                setFollowing(isF);
            }
        }
        setLoading(false);
    };

    const handleFollowToggle = async () => {
        if (!profile || !currentUser) return;
        setActionLoading(true);
        if (following) {
            const success = await unfollowUser(profile.id);
            if (success) {
                setFollowing(false);
                setFollowersCount(prev => Math.max(0, prev - 1));
            }
        } else {
            const success = await followUser(profile.id);
            if (success) {
                setFollowing(true);
                setFollowersCount(prev => prev + 1);
            }
        }
        setActionLoading(false);
    };

    if (loading) {
        return <div className={cn('flex h-screen items-center justify-center', CANVAS_BG, MUTED)}>Loading profile...</div>;
    }

    if (!profile) {
        return <div className={cn('flex h-screen items-center justify-center', CANVAS_BG, MUTED)}>User not found.</div>;
    }

    return (
        <div className={cn('min-h-screen pb-20 text-[var(--ds-ink)]', CANVAS_BG)}>
            <div className="container mx-auto max-w-5xl p-4 md:p-6">
                <div className="mb-6">
                    <Button variant="ghost" size="sm" onClick={() => onNavigate('gallery')} className={MUTED}>
                        Back to Library
                    </Button>
                </div>
                {/* Profile Card */}
                <div className={cn(SECTION_CARD, 'mb-10 flex flex-col items-center gap-8 p-6 md:flex-row md:items-start md:p-8')}>
                    <div className="shrink-0">
                        <UserAvatar url={profile.avatar_url} name={profile.username} size="lg" className="w-32 h-32 text-4xl" />
                    </div>
                    <div className="flex-1 text-center md:text-left">
                        <h1 className={cn(HEADING, TEXT_3XL, 'mb-2 [overflow-wrap:anywhere]')}>{profile.username}</h1>
                        <p className={cn('mb-4 max-w-lg', MUTED)}>{profile.bio || "This user hasn't written a bio yet."}</p>

                        <div className="mb-6 flex items-center justify-center gap-6 md:justify-start">
                            <div className="flex flex-col items-center md:items-start">
                                <span className="text-xl font-semibold tabular-nums">{projects.length}</span>
                                <span className={OVERLINE}>Comics</span>
                            </div>
                            <div className="flex flex-col items-center md:items-start">
                                <span className="text-xl font-semibold tabular-nums">{followersCount}</span>
                                <span className={OVERLINE}>Followers</span>
                            </div>
                        </div>

                        {currentUser && currentUser.id !== profile.id && (
                            <Button
                                onClick={handleFollowToggle}
                                loading={actionLoading}
                                variant={following ? 'secondary' : 'default'}
                                className="w-full md:w-auto"
                            >
                                {following ? (
                                    <>
                                        <UserCheck aria-hidden="true" /> Following
                                    </>
                                ) : (
                                    <>
                                        <UserPlus aria-hidden="true" /> Follow
                                    </>
                                )}
                            </Button>
                        )}
                        {currentUser && currentUser.id === profile.id && (
                            <Button onClick={() => onNavigate('settings')} variant="secondary">
                                Edit Profile
                            </Button>
                        )}
                    </div>
                </div>

                {/* Comics Grid */}
                <div>
                    <h2 className={cn(HEADING, TEXT_2XL, 'mb-6 flex items-center gap-2')}>
                        <Grid className="size-6 shrink-0" aria-hidden="true" />
                        Released Comics
                    </h2>

                    {projects.length === 0 ? (
                        <div className={cn('border border-dashed border-[var(--ds-hairline)] bg-[var(--ds-surface)] py-20 text-center', RADIUS_PANEL)}>
                            <p className={MUTED}>No public comics yet.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {projects.map(project => {
                                const covers = coverCandidates(project);
                                // A published v4 comic opens its read-only share link (/c/<slug>) as a real
                                // page load, like the gallery: it serves the boot card, the preview head and
                                // its own CSP. Everything else opens the in-app reader; the href keeps
                                // open-in-new-tab and copy-link working.
                                const slug = shareSlugOf(project);
                                return (
                                    <a
                                        key={project.id}
                                        href={slug ? SHARE_PATH(slug) : `/?view=read&id=${encodeURIComponent(project.id)}`}
                                        onClick={
                                            slug
                                                ? undefined
                                                : (e) => {
                                                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                                                    e.preventDefault();
                                                    onNavigate('reader', project.id);
                                                }
                                        }
                                        aria-label={`Read ${project.name}`}
                                        data-share-slug={slug}
                                        className={cn('group block cursor-pointer', SECTION_CARD, LIFT, FOCUS_RING)}
                                    >
                                        <div className="relative aspect-[2/3] overflow-hidden bg-[var(--ds-well)] text-center">
                                            <SmartImage
                                                src={covers[0]}
                                                fallbackSources={covers.slice(1)}
                                                alt={project.name}
                                                className="w-full h-full object-cover"
                                                containerClassName="w-full h-full"
                                                fallbackIcon={<BookOpen size={32} className={MUTED} aria-hidden="true" />}
                                            />
                                            {/* Hover Overlay */}
                                            <div className={cn('absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none', SCRIM)}>
                                                <span className={cn('bg-[var(--ds-canvas)] px-4 py-2 text-sm font-semibold text-[var(--ds-ink)]', RADIUS_PILL, SHADOW_SOFT)}>
                                                    Read Comic
                                                </span>
                                            </div>
                                            {/* The publish gate's rating — only for a real publication (a v4 row with its server-mirrored
                                                share slug), the same gate as the gallery: the column is server-set, but a row that no
                                                longer reads as a publication shows its art outside the gate and gets no badge. */}
                                            {slug && project.contentRating && (
                                                <div className="absolute left-2 top-2">
                                                    <RatingBadge rating={project.contentRating} />
                                                </div>
                                            )}
                                        </div>
                                        <div className="p-4">
                                            <h3 className={cn(HEADING, 'mb-1 truncate text-base')}>{project.name}</h3>
                                            <div className={cn('flex items-center justify-between text-xs font-medium tabular-nums', MUTED)}>
                                                <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                                                <div className="flex gap-3">
                                                    <span className="flex items-center gap-1"><Eye className="size-3" aria-hidden="true" /> {(project as any).views || 0}</span>
                                                    <span className="flex items-center gap-1"><Heart className="size-3" aria-hidden="true" /> {(project as any).likes || 0}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </a>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

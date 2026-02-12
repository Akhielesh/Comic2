import React, { useEffect, useState } from 'react';
import { UserProfile, Project } from '../types';
import { getProfileByUsername, getPublicProjectsByUser, isFollowing, followUser, unfollowUser, getFollowersCount } from '../services/db';
import { UserAvatar } from './UserAvatar';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './Button';
import { UserPlus, UserCheck, Grid, Heart, Eye } from 'lucide-react';


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

    const loadData = async () => {
        setLoading(true);
        const p = await getProfileByUsername(username);
        if (p) {
            setProfile(p);
            const projs = await getPublicProjectsByUser(p.id);
            setProjects(projs);

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
        return <div className="flex h-screen items-center justify-center">Loading profile...</div>;
    }

    if (!profile) {
        return <div className="flex h-screen items-center justify-center">User not found.</div>;
    }

    return (
        <div className="min-h-screen bg-slate-100 pb-20">
            <div className="container mx-auto max-w-5xl p-4 md:p-6">
                <div className="mb-6">
                    <button onClick={() => onNavigate('gallery')} className="text-xs font-bold text-slate-500 hover:text-black">
                        Back to Library
                    </button>
                </div>
                {/* Profile Card */}
                <div className="bg-white border-4 border-black shadow-comic rounded-xl p-6 md:p-8 mb-10 flex flex-col md:flex-row items-center md:items-start gap-8">
                    <div className="flex-shrink-0">
                        <UserAvatar url={profile.avatar_url} name={profile.username} size="lg" className="w-32 h-32 text-4xl" />
                    </div>
                    <div className="flex-1 text-center md:text-left">
                        <h1 className="font-display text-4xl mb-2">{profile.username}</h1>
                        <p className="text-slate-600 mb-4 max-w-lg">{profile.bio || "This user hasn't written a bio yet."}</p>

                        <div className="flex items-center justify-center md:justify-start gap-6 mb-6 text-sm font-bold">
                            <div className="flex flex-col items-center md:items-start">
                                <span className="text-xl">{projects.length}</span>
                                <span className="text-slate-500 uppercase text-xs">Comics</span>
                            </div>
                            <div className="flex flex-col items-center md:items-start">
                                <span className="text-xl">{followersCount}</span>
                                <span className="text-slate-500 uppercase text-xs">Followers</span>
                            </div>
                        </div>

                        {currentUser && currentUser.id !== profile.id && (
                            <Button
                                onClick={handleFollowToggle}
                                isLoading={actionLoading}
                                variant={following ? "secondary" : "primary"}
                                className="w-full md:w-auto"
                            >
                                {following ? (
                                    <>
                                        <UserCheck className="w-4 h-4 mr-2" /> Following
                                    </>
                                ) : (
                                    <>
                                        <UserPlus className="w-4 h-4 mr-2" /> Follow
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
                    <h2 className="font-display text-2xl mb-6 flex items-center gap-2">
                        <Grid className="w-6 h-6" />
                        Released Comics
                    </h2>

                    {projects.length === 0 ? (
                        <div className="text-center py-20 bg-white border-2 border-dashed border-slate-300 rounded-xl">
                            <p className="text-slate-400">No public comics yet.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {projects.map(project => {
                                let imgSrc = project.coverImage || project.state?.coverImageUrl;
                                if (!imgSrc && project.state?.panels?.some(p => p.imageUrl)) {
                                    imgSrc = project.state.panels.find(p => p.imageUrl)?.imageUrl;
                                }
                                if (!imgSrc && project.state?.styleVariants?.length > 0) {
                                    imgSrc = project.state.styleVariants[0].imageUrl;
                                }
                                return (
                                    <div
                                        key={project.id}
                                        onClick={() => onNavigate('reader', project.id)}
                                        className="bg-white border-4 border-black rounded-xl overflow-hidden shadow-comic hover:scale-[1.02] transition-transform cursor-pointer group"
                                    >
                                        <div className="aspect-[2/3] bg-slate-200 relative overflow-hidden text-center">
                                            {imgSrc ? (
                                                <img src={imgSrc} className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-slate-400 font-display text-lg">No Cover</div>
                                            )}
                                            {/* Hover Overlay */}
                                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                <span className="bg-white text-black font-bold px-4 py-2 rounded-full border-2 border-black transform -rotate-3 text-sm">
                                                    Read Comic
                                                </span>
                                            </div>
                                        </div>
                                        <div className="p-4">
                                            <h3 className="font-display text-lg truncate mb-1">{project.name}</h3>
                                            <div className="flex justify-between items-center text-xs font-bold text-slate-500">
                                                <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
                                                <div className="flex gap-3">
                                                    <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {(project as any).views || 0}</span>
                                                    <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> {(project as any).likes || 0}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

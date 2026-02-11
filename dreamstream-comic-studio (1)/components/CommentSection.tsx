import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Comment } from '../types';
import { addComment, getComments, deleteComment, likeComment, unlikeComment, createNotification } from '../services/db';
import { UserAvatar } from './UserAvatar';
import { Send, Trash2, MessageSquare, Heart } from 'lucide-react';
import { Button } from './Button';

interface CommentSectionProps {
    projectId: string;
    onNavigate?: (view: string, id?: string) => void;
}

export const CommentSection: React.FC<CommentSectionProps> = ({ projectId, onNavigate }) => {
    const { user } = useAuth();
    const [comments, setComments] = useState<Comment[]>([]);
    const [newComment, setNewComment] = useState('');
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        loadComments();
    }, [projectId]);

    const loadComments = async () => {
        setLoading(true);
        const data = await getComments(projectId, user?.id);
        setComments(data);
        setLoading(false);
    };

    const handleLike = async (comment: Comment) => {
        if (!user) return;

        // Optimistic update
        const isLiked = !!comment.isLiked;
        setComments(prev => prev.map(c =>
            c.id === comment.id
                ? { ...c, isLiked: !isLiked, likes: (c.likes || 0) + (isLiked ? -1 : 1) }
                : c
        ));

        if (isLiked) {
            await unlikeComment(comment.id, user.id);
        } else {
            if (comment.user_id !== user.id) {
                await createNotification(comment.user_id, user.id, 'like', comment.id);
            }
            await likeComment(comment.id, user.id);
        }
    };

    const handlePost = async () => {
        if (!newComment.trim() || !user) return;
        setSubmitting(true);
        const added = await addComment(projectId, newComment);
        if (added) {
            setComments(prev => [...prev, added]);
            setNewComment('');
        }
        setSubmitting(false);
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Delete this comment?")) return;
        const success = await deleteComment(id);
        if (success) {
            setComments(prev => prev.filter(c => c.id !== id));
        }
    };

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="bg-white border-t-2 border-slate-200 p-6">
            <h3 className="font-display text-xl mb-6 flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                Comments ({comments.length})
            </h3>

            {/* List */}
            <div className="space-y-6 mb-8 max-h-[500px] overflow-y-auto">
                {loading ? (
                    <p className="text-slate-400 italic">Loading comments...</p>
                ) : comments.length === 0 ? (
                    <p className="text-slate-400 italic">No comments yet. Be the first!</p>
                ) : (
                    comments.map(c => (
                        <div key={c.id} className="flex gap-4 group">
                            <div className="flex-shrink-0">
                                <UserAvatar
                                    url={c.user?.avatar_url}
                                    name={c.user?.username || 'User'}
                                    size="sm"
                                    onClick={() => c.user?.username && onNavigate?.('profile', c.user.username)}
                                />
                            </div>
                            <div className="flex-1">
                                <div className="flex items-baseline justify-between mb-1">
                                    <span
                                        onClick={() => c.user?.username && onNavigate?.('profile', c.user.username)}
                                        className="font-bold text-sm hover:underline cursor-pointer"
                                    >
                                        {c.user?.username || 'Anonymous'}
                                    </span>
                                    <span className="text-xs text-slate-400">{formatTime(c.created_at)}</span>
                                </div>
                                <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">{c.text}</p>
                                <div className="mt-2 flex items-center gap-4">
                                    <button
                                        onClick={() => handleLike(c)}
                                        className={`flex items-center gap-1 text-xs transition-colors ${c.isLiked ? 'text-red-500' : 'text-slate-400 hover:text-red-500'}`}
                                        disabled={!user}
                                    >
                                        <Heart className={`w-3 h-3 ${c.isLiked ? 'fill-current' : ''}`} />
                                        {c.likes || 0}
                                    </button>
                                </div>
                            </div>
                            {user?.id === c.user_id && (
                                <button
                                    onClick={() => handleDelete(c.id)}
                                    className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity self-start"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>

            {/* Input */}
            {user ? (
                <div className="flex gap-3 items-start">
                    <div className="flex-shrink-0 pt-1">
                        <UserAvatar url={undefined} name={user.email?.[0] || 'U'} size="sm" />
                        {/* Ideally current user avatar from profile context, but user object usually just has auth info. 
                            We fetched profile in dashboard usually. 
                            For now using initial. */}
                    </div>
                    <div className="flex-1">
                        <textarea
                            value={newComment}
                            onChange={(e) => setNewComment(e.target.value)}
                            placeholder="Write a comment..."
                            className="w-full border-2 border-slate-200 rounded-lg p-3 text-sm focus:border-black focus:outline-none resize-none h-20"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handlePost();
                                }
                            }}
                        />
                        <div className="flex justify-end mt-2">
                            <Button
                                onClick={handlePost}
                                variant="primary"
                                disabled={submitting || !newComment.trim()}
                                isLoading={submitting}
                            >
                                <Send className="w-4 h-4 mr-2" />
                                Post
                            </Button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="bg-slate-50 p-4 rounded-lg text-center text-sm text-slate-500">
                    Please <button className="text-black font-bold underline">log in</button> to comment.
                </div>
            )}
        </div>
    );
};

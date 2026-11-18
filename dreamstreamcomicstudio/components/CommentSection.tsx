import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Comment } from '../types';
import { addComment, getComments, deleteComment, likeComment, unlikeComment, createNotification, updateComment } from '../services/db';
import { UserAvatar } from './UserAvatar';
import { Send, Trash2, MessageSquare, Heart, Edit2, Save, X } from 'lucide-react';
import { Button } from './Button';
import { buttonClasses } from './ds/Button';
import { FIELD, FOCUS_RING, INK, MUTED, RADIUS_PANEL } from './chat/studioDesign';

const COMMENT_FIELD = `${FIELD} block w-full resize-none text-sm`;
const ROW_ACTION = buttonClasses({ variant: 'ghost', size: 'icon', className: `size-8 ${MUTED}` });
const ROW_DELETE = buttonClasses({ variant: 'ghost', size: 'icon', className: `size-8 ${MUTED} hover:text-[var(--ds-danger-text)]` });

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
    const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);

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
                await createNotification(comment.user_id, user.id, 'like', comment.project_id);
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

    const handleStartEdit = (comment: Comment) => {
        setEditingCommentId(comment.id);
        setEditingText(comment.text);
    };

    const handleCancelEdit = () => {
        setEditingCommentId(null);
        setEditingText('');
    };

    const handleSaveEdit = async (commentId: string) => {
        const trimmed = editingText.trim();
        if (!trimmed) return;
        setSavingEdit(true);
        const updated = await updateComment(commentId, trimmed);
        if (updated) {
            setComments(prev => prev.map(c => c.id === commentId ? { ...c, ...updated } : c));
        }
        setSavingEdit(false);
        handleCancelEdit();
    };

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="border-t border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6">
            <h3 className="mb-6 flex items-center gap-2 text-[length:var(--ds-text-lg)] font-semibold leading-6 text-[var(--ds-ink)]">
                <MessageSquare className="w-5 h-5" />
                Comments ({comments.length})
            </h3>

            {/* List */}
            <div className="space-y-6 mb-8 max-h-[500px] overflow-y-auto">
                {loading ? (
                    <p className={`text-sm ${MUTED}`} role="status">Loading comments...</p>
                ) : comments.length === 0 ? (
                    <p className={`text-sm ${MUTED}`}>No comments yet. Be the first!</p>
                ) : (
                    comments.map(c => (
                        <div key={c.id} className="flex gap-4 group">
                            <div className="shrink-0">
                                <UserAvatar
                                    url={c.user?.avatar_url}
                                    name={c.user?.username || 'User'}
                                    size="sm"
                                    onClick={() => c.user?.username && onNavigate?.('profile', c.user.username)}
                                />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
                                    <span
                                        onClick={() => c.user?.username && onNavigate?.('profile', c.user.username)}
                                        className={`cursor-pointer text-sm font-semibold hover:underline ${INK}`}
                                    >
                                        {c.user?.username || 'Anonymous'}
                                    </span>
                                    <span className={`text-xs ${MUTED}`}>
                                        {formatTime(c.created_at)}
                                        {c.updated_at ? ' (edited)' : ''}
                                    </span>
                                </div>
                                {editingCommentId === c.id ? (
                                    <div className="space-y-2">
                                        <textarea
                                            value={editingText}
                                            onChange={(e) => setEditingText(e.target.value)}
                                            className={`${COMMENT_FIELD} h-20 p-2`}
                                        />
                                        <div className="flex items-center gap-2">
                                            <Button
                                                size="sm"
                                                onClick={() => handleSaveEdit(c.id)}
                                                disabled={savingEdit || !editingText.trim()}
                                                isLoading={savingEdit}
                                            >
                                                <Save className="size-3.5" />
                                                Save
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={handleCancelEdit}
                                            >
                                                <X className="size-3.5" />
                                                Cancel
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className={`whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere] ${INK}`}>{c.text}</p>
                                )}
                                <div className="mt-2 flex items-center gap-4">
                                    <button
                                        onClick={() => handleLike(c)}
                                        className={`inline-flex min-h-8 items-center gap-1 rounded-[var(--ds-radius-control)] px-1.5 text-xs tabular-nums transition-colors duration-[var(--ds-motion-medium)] coarse:min-h-[var(--ds-density-touch)] disabled:cursor-not-allowed ${FOCUS_RING} ${c.isLiked ? INK : `${MUTED} hover:text-[var(--ds-ink)]`}`}
                                        disabled={!user}
                                    >
                                        <Heart className={`w-3 h-3 ${c.isLiked ? 'fill-current' : ''}`} />
                                        {c.likes || 0}
                                    </button>
                                </div>
                            </div>
                            {user?.id === c.user_id && (
                                <div className="flex items-center gap-1 self-start opacity-0 transition-opacity duration-[var(--ds-motion-medium)] focus-within:opacity-100 group-hover:opacity-100">
                                    <button
                                        onClick={() => handleStartEdit(c)}
                                        className={ROW_ACTION}
                                        disabled={editingCommentId === c.id}
                                        title="Edit comment"
                                    >
                                        <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(c.id)}
                                        className={ROW_DELETE}
                                        title="Delete comment"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {/* Input */}
            {user ? (
                <div className="flex gap-3 items-start">
                    <div className="shrink-0 pt-1">
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
                            className={`${COMMENT_FIELD} h-20 p-3`}
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
                                <Send className="size-4" />
                                Post
                            </Button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className={`bg-[var(--ds-well)] p-4 text-center text-sm ${RADIUS_PANEL} ${MUTED}`}>
                    Please <button onClick={() => onNavigate?.('auth')} className={`font-semibold underline underline-offset-4 ${INK} ${FOCUS_RING}`}>log in</button> to comment.
                </div>
            )}
        </div>
    );
};


import React, { useId, useState } from 'react';
import { X, Star, MessageSquare } from 'lucide-react';
import { Review } from '../../types';
import { buttonClasses } from '../ds/Button';
import { DIALOG_TITLE, FIELD, FOCUS_RING, HAIRLINE, INK, MUTED, OVERLAY, OVERLINE, RADIUS_PANEL, SCRIM, Z } from '../chat/studioDesign';

interface ReviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (reviewData: Omit<Review, 'id' | 'userId' | 'createdAt' | 'projectId'>) => Promise<void>;
    projectName: string;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({ isOpen, onClose, onSubmit, projectName }) => {
    const [rating, setRating] = useState(0); // Main 5-star
    const [scores, setScores] = useState({
        story: 3,
        art: 3,
        characters: 3,
        pacing: 3
    });
    const [comment, setComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const titleId = useId();

    if (!isOpen) return null;

    const handleStarClick = (idx: number, isHalf: boolean) => {
        // idx is 1-based index of star
        // if isHalf, value is idx - 0.5
        // else value is idx
        let val = idx;
        if (isHalf) val -= 0.5;
        setRating(val);
    };

    const handleScoreChange = (key: keyof typeof scores, val: number) => {
        setScores(prev => ({ ...prev, [key]: val }));
    };

    const submit = async () => {
        if (rating === 0) return; // Require at least a rating?
        setIsSubmitting(true);
        try {
            await onSubmit({
                rating,
                scores,
                text: comment
            });
            onClose();
        } catch (e) {
            console.error("Review failed", e);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center overflow-y-auto p-4 animate-fade-in motion-reduce:animate-none`}>
            <div role="dialog" aria-labelledby={titleId} className={`${OVERLAY} relative max-h-[calc(var(--app-h,100dvh)-2rem)] w-full max-w-md overflow-y-auto animate-slide-up motion-reduce:animate-none`}>
                <button
                    onClick={onClose}
                    aria-label="Close"
                    className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'absolute right-3 top-3 text-[var(--ds-muted)]' })}
                >
                    <X className="size-5" />
                </button>

                <div className="border-b border-[var(--ds-hairline)] px-12 py-6 text-center">
                    <h2 id={titleId} className={`mb-1 [overflow-wrap:anywhere] ${DIALOG_TITLE}`}>Rate "{projectName}"</h2>
                    <p className={`text-sm ${MUTED}`}>How was it? Be honest!</p>
                </div>

                <div className="p-6 space-y-6">
                    {/* Main Star Rating Display (Read Only) */}
                    <div className="flex justify-center gap-2 pointer-events-none opacity-90">
                        {[1, 2, 3, 4, 5].map((starIdx) => {
                            const fill = Math.max(0, Math.min(1, rating - starIdx + 1));
                            return (
                                <div key={starIdx} className="relative w-10 h-10">
                                    <Star className="h-full w-full fill-[var(--ds-well-strong)] text-[var(--ds-well-strong)]" aria-hidden="true" />
                                    <div className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                                        <Star className="h-full w-full fill-[var(--ds-ink)] text-[var(--ds-ink)]" aria-hidden="true" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className={`text-center text-xl font-semibold tabular-nums ${INK}`}>
                        {rating > 0 ? rating.toFixed(1) : "Rate the categories below!"}
                    </div>

                    {/* Sub Scores Input */}
                    <div className={`grid grid-cols-2 gap-4 bg-[var(--ds-well)] p-4 ${RADIUS_PANEL} ${HAIRLINE}`}>
                        {(Object.keys(scores) as Array<keyof typeof scores>).map(key => (
                            <div key={key} className="flex flex-col gap-1">
                                <div className={`flex justify-between ${OVERLINE}`}>
                                    {key} <span className={`tabular-nums ${scores[key] > 0 ? INK : MUTED}`}>{scores[key] || '-'}/5</span>
                                </div>
                                {/* Custom Star Input for Sub-categories or Range? Range is easier for now, Stars are nicer. Let's use Stars for sub-cats too? Space is tight. Range is fine. */}
                                <div className="flex items-center gap-1">
                                    {[1, 2, 3, 4, 5].map(v => (
                                        <button
                                            key={v}
                                            onClick={() => handleScoreChange(key, v)}
                                            aria-label={`${key} ${v} of 5`}
                                            aria-pressed={v <= scores[key]}
                                            className={`group/score flex h-6 w-full items-center coarse:h-11 ${FOCUS_RING}`}
                                        >
                                            <span aria-hidden="true" className={`h-2 w-full rounded-[var(--ds-radius-pill)] transition-colors duration-[var(--ds-motion-medium)] ${v <= scores[key] ? 'bg-[var(--ds-ink)]' : 'bg-[var(--ds-well-strong)] group-hover/score:bg-[var(--ds-hairline)]'}`} />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Comment */}
                    <div className="relative">
                        <textarea
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            placeholder="Write a review (optional)..."
                            aria-label="Review"
                            className={`${FIELD} block h-24 w-full resize-none p-3 text-sm`}
                        />
                        <MessageSquare className={`pointer-events-none absolute bottom-3 right-3 size-4 ${MUTED}`} aria-hidden="true" />
                    </div>

                    <div className="flex gap-3">
                        <button
                            onClick={onClose}
                            className={buttonClasses({ variant: 'ghost', size: 'lg', className: 'flex-1' })}
                        >
                            Skip
                        </button>
                        <button
                            onClick={submit}
                            disabled={rating === 0 || isSubmitting}
                            className={buttonClasses({ size: 'lg', className: 'flex-1 disabled:cursor-not-allowed' })}
                        >
                            {isSubmitting ? 'Posting...' : 'Post Review'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

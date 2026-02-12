
import React, { useState } from 'react';
import { X, Star, MessageSquare } from 'lucide-react';
import { Review } from '../../types';

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
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
            <div className="bg-white rounded-xl shadow-2xl border-4 border-black w-full max-w-md overflow-hidden animate-slide-up relative">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 hover:bg-slate-100 rounded-full"
                >
                    <X className="w-5 h-5 text-slate-500" />
                </button>

                <div className="p-6 text-center border-b-2 border-slate-100">
                    <h2 className="font-display text-2xl mb-1">Rate "{projectName}"</h2>
                    <p className="text-slate-500 text-sm font-comic">How was it? Be honest!</p>
                </div>

                <div className="p-6 space-y-6">
                    {/* Main Star Rating Display (Read Only) */}
                    <div className="flex justify-center gap-2 pointer-events-none opacity-90">
                        {[1, 2, 3, 4, 5].map((starIdx) => {
                            const fill = Math.max(0, Math.min(1, rating - starIdx + 1));
                            return (
                                <div key={starIdx} className="relative w-10 h-10">
                                    <Star className="w-full h-full text-slate-200 fill-slate-200" />
                                    <div className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                                        <Star className="w-full h-full text-brand-yellow fill-brand-yellow drop-shadow-sm" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="text-center font-bold text-xl text-brand-yellow">
                        {rating > 0 ? rating.toFixed(1) : "Rate the categories below!"}
                    </div>

                    {/* Sub Scores Input */}
                    <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-lg border-2 border-slate-200 animate-fade-in">
                        {(Object.keys(scores) as Array<keyof typeof scores>).map(key => (
                            <div key={key} className="flex flex-col gap-1">
                                <div className="flex justify-between text-xs font-bold uppercase text-slate-500">
                                    {key} <span className={scores[key] > 0 ? "text-black" : "text-slate-300"}>{scores[key] || '-'}/5</span>
                                </div>
                                {/* Custom Star Input for Sub-categories or Range? Range is easier for now, Stars are nicer. Let's use Stars for sub-cats too? Space is tight. Range is fine. */}
                                <div className="flex items-center gap-1 h-6">
                                    {[1, 2, 3, 4, 5].map(v => (
                                        <button
                                            key={v}
                                            onClick={() => handleScoreChange(key, v)}
                                            className={`w-full h-2 rounded-full transition-all ${v <= scores[key] ? 'bg-brand-blue' : 'bg-slate-200 hover:bg-slate-300'}`}
                                        />
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
                            className="w-full h-24 p-3 border-2 border-slate-300 rounded-lg focus:border-black focus:outline-none resize-none font-comic text-sm"
                        />
                        <MessageSquare className="absolute bottom-3 right-3 text-slate-300 w-4 h-4" />
                    </div>

                    <div className="flex gap-3">
                        <button
                            onClick={onClose}
                            className="flex-1 py-3 font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors border-2 border-transparent hover:border-slate-200"
                        >
                            Skip
                        </button>
                        <button
                            onClick={submit}
                            disabled={rating === 0 || isSubmitting}
                            className={`flex-1 py-3 font-bold text-white rounded-lg border-2 border-black shadow-comic transition-all ${rating > 0 && !isSubmitting ? 'bg-brand-blue hover:-translate-y-1 hover:shadow-lg' : 'bg-slate-300 cursor-not-allowed border-slate-300'}`}
                        >
                            {isSubmitting ? 'Posting...' : 'Post Review'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

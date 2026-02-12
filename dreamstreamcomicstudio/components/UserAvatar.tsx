import React, { useState, useEffect, useRef } from 'react';
import { User } from 'lucide-react';
import { getUserProfile } from '../services/db';
import { useAuth } from '../contexts/AuthContext';

interface UserAvatarProps {
    className?: string;
    onClick?: () => void;
    url?: string | null;
    name?: string;
    size?: 'sm' | 'md' | 'lg';
}

export const UserAvatar: React.FC<UserAvatarProps> = ({ className, onClick, url, name, size = 'md' }) => {
    const { user } = useAuth();
    const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);

    // If url is undefined, we assume we should show the current logged-in user's avatar
    const isExplicit = url !== undefined;

    useEffect(() => {
        if (!isExplicit && user) {
            getUserProfile(user.id).then(p => {
                if (p?.avatar_url) setFetchedUrl(p.avatar_url);
            });
        }
    }, [user, isExplicit]);

    const finalUrl = isExplicit ? url : fetchedUrl;
    const finalName = isExplicit ? name : (user?.email || 'User');
    const initial = finalName ? finalName[0].toUpperCase() : 'U';

    const sizeClasses = {
        sm: 'w-8 h-8 text-xs',
        md: 'w-10 h-10 text-sm',
        lg: 'w-16 h-16 text-lg'
    };

    return (
        <div onClick={onClick} className={`relative group ${className || ''} ${onClick ? 'cursor-pointer' : ''}`}>
            <div className={`${sizeClasses[size]} rounded-full border-2 border-black overflow-hidden bg-slate-200 hover:scale-105 transition-transform shadow-comic-sm flex items-center justify-center`}>
                {finalUrl ? (
                    <img src={finalUrl} alt={finalName} className="w-full h-full object-cover" />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-500 bg-slate-100 font-bold font-comic">
                        {initial}
                    </div>
                )}
            </div>
            {/* Status Dot only if it's the current user (implicit mode) */}
            {!isExplicit && user && (
                <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></div>
            )}
        </div>
    );
};

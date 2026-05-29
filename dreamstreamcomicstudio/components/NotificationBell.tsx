import React, { useState, useEffect, useRef } from 'react';
import { Bell, Heart, MessageSquare, UserPlus, Sparkles, AlertTriangle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getNotifications, markAllNotificationsRead, markNotificationRead } from '../services/db';
import { AppNotification } from '../types';

// Friendly text for usage-alert system notifications (entity_id: usage:<kind>:<pct>:<period>).
const usageAlertText = (entityId?: string | null): string | null => {
    if (!entityId || !entityId.startsWith('usage:')) return null;
    const [, kind, pct] = entityId.split(':');
    const scope = kind === 'spendcap' ? 'monthly spend cap' : 'daily usage limit';
    if (pct === '100') return `You've reached your ${scope}.`;
    return `You've used ${pct}% of your ${scope}.`;
};

const formatWhen = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
};

interface NotificationBellProps {
    onNavigate: (view: string, id?: string) => void;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ onNavigate }) => {
    const { user } = useAuth();
    const [notifications, setNotifications] = useState<AppNotification[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!user) return;
        loadNotifications();

        // Poll for notifications every 30s
        const interval = setInterval(loadNotifications, 30000);
        return () => clearInterval(interval);
    }, [user]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const loadNotifications = async () => {
        if (!user) return;
        const data = await getNotifications(user.id);
        setNotifications(data);
        setUnreadCount(data.filter(n => !n.is_read).length);
    };

    const handleClick = () => {
        setIsOpen(!isOpen);
    };

    const handleNotificationClick = async (n: AppNotification) => {
        if (!n.is_read) {
            await markNotificationRead(n.id);
            loadNotifications();
        }
        setIsOpen(false);

        if (n.type === 'comment' && n.entity_id) {
            onNavigate('reader', n.entity_id);
        } else if (n.type === 'follow' && n.actor?.username) {
            onNavigate('profile', n.actor.username);
        } else if ((n.type === 'like' || n.type === 'generation') && n.entity_id) {
            onNavigate('reader', n.entity_id);
        } else if (n.type === 'system') {
            onNavigate('dashboard');
        }
    };

    if (!user) return null;

    const typeIcon = (n: AppNotification) => {
        if (n.type === 'like') return <Heart className="w-4 h-4 text-brand-red fill-current" />;
        if (n.type === 'comment') return <MessageSquare className="w-4 h-4 text-brand-blue fill-current" />;
        if (n.type === 'follow') return <UserPlus className="w-4 h-4 text-green-600" />;
        if (n.type === 'generation') return <Sparkles className="w-4 h-4 text-purple-600" />;
        return <AlertTriangle className="w-4 h-4 text-amber-600" />;
    };

    const bodyText = (n: AppNotification): { title: string; sub?: string } => {
        if (n.title) return { title: n.title, sub: n.message };
        if (n.type === 'system') return { title: usageAlertText(n.entity_id) || 'System notification', sub: n.message };
        const who = n.actor?.username || 'Someone';
        if (n.type === 'like') return { title: `${who} liked your comic` };
        if (n.type === 'comment') return { title: `${who} commented on your comic` };
        if (n.type === 'follow') return { title: `${who} started following you` };
        if (n.type === 'generation') return { title: n.message || 'Your latest generation is complete.' };
        return { title: 'Notification', sub: n.message };
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={handleClick}
                aria-label="Notifications"
                className="relative w-10 h-10 flex items-center justify-center bg-white border-2 border-black rounded-lg shadow-comic hover:bg-brand-yellow transition-colors"
            >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                    <span className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1 bg-brand-red text-white text-[11px] font-bold rounded-full border-2 border-black flex items-center justify-center">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-3 w-[22rem] max-w-[90vw] bg-white border-2 border-black rounded-xl shadow-comic z-50 overflow-hidden">
                    <div className="px-4 py-3 border-b-2 border-black flex justify-between items-center bg-brand-yellow/30">
                        <h3 className="font-display text-lg leading-none">Notifications</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!user) return;
                                    await markAllNotificationsRead(user.id);
                                    await loadNotifications();
                                }}
                                className="text-xs font-bold text-brand-blue hover:underline"
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    <div className="max-h-96 overflow-y-auto divide-y divide-slate-200">
                        {notifications.length === 0 ? (
                            <div className="p-8 text-center text-slate-500 text-sm font-comic">
                                You're all caught up.
                            </div>
                        ) : (
                            notifications.map(n => {
                                const body = bodyText(n);
                                return (
                                    <button
                                        key={n.id}
                                        onClick={() => handleNotificationClick(n)}
                                        className={`w-full text-left p-3 hover:bg-brand-yellow/15 cursor-pointer flex items-start gap-3 transition-colors ${!n.is_read ? 'bg-brand-blue/5' : ''}`}
                                    >
                                        <div className="mt-0.5 w-7 h-7 shrink-0 rounded-lg border-2 border-black bg-white flex items-center justify-center">
                                            {typeIcon(n)}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-slate-900 font-semibold leading-snug">{body.title}</p>
                                            {body.sub && <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{body.sub}</p>}
                                            <p className="text-[11px] text-slate-400 mt-1">{formatWhen(n.created_at)}</p>
                                        </div>
                                        {!n.is_read && <span className="w-2.5 h-2.5 bg-brand-red rounded-full shrink-0 mt-1.5" />}
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

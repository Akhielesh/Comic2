import React, { useState, useEffect, useRef } from 'react';
import { Bell, Heart, MessageSquare, UserPlus, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getNotifications, markNotificationRead } from '../services/db';
import { AppNotification } from '../types';

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
        if (!isOpen && unreadCount > 0) {
            // Mark visible as read? Or mark individual on click?
            // Usually mark all read when opening or individual.
            // Let's mark all as read locally for UI clear, and async update DB?
            // Or just leave them unread until clicked? 
            // Let's leave unread until clicked or "Mark all read" button.
        }
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
        } else if (n.type === 'like' && n.entity_id) {
            // if entity_id is comment, maybe go to threaded view? 
            // if entity_id is project, go to reader
            onNavigate('reader', n.entity_id);
        }
    };

    if (!user) return null;

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={handleClick}
                className="relative p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
                <Bell className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white dark:border-gray-900" />
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-xl z-50 overflow-hidden">
                    <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center">
                        <h3 className="font-semibold text-sm">Notifications</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    // Mark all logic would go here
                                    notifications.forEach(n => !n.is_read && markNotificationRead(n.id));
                                    setNotifications(notifications.map(n => ({ ...n, is_read: true })));
                                    setUnreadCount(0);
                                }}
                                className="text-xs text-blue-500 hover:text-blue-600"
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="p-8 text-center text-gray-500 text-sm">
                                No notifications yet
                            </div>
                        ) : (
                            notifications.map(n => (
                                <div
                                    key={n.id}
                                    onClick={() => handleNotificationClick(n)}
                                    className={`p-3 border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer flex items-start gap-3 transition-colors ${!n.is_read ? 'bg-blue-50/30' : ''}`}
                                >
                                    <div className="mt-1">
                                        {n.type === 'like' && <Heart className="w-4 h-4 text-red-500 fill-current" />}
                                        {n.type === 'comment' && <MessageSquare className="w-4 h-4 text-blue-500 fill-current" />}
                                        {n.type === 'follow' && <UserPlus className="w-4 h-4 text-green-500 fill-current" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-gray-900 dark:text-gray-100">
                                            <span className="font-semibold">{n.actor?.username || 'Someone'}</span>
                                            {' '}
                                            {n.type === 'like' && 'liked your comment'}
                                            {n.type === 'comment' && 'commented on your comic'}
                                            {n.type === 'follow' && 'started following you'}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-1">
                                            {new Date(n.created_at).toLocaleDateString()}
                                        </p>
                                    </div>
                                    {!n.is_read && (
                                        <div className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0 mt-2" />
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

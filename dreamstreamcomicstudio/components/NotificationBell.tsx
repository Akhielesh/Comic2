import React, { useState, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { Bell, Heart, MessageSquare, UserPlus, Sparkles, AlertTriangle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getNotifications, markAllNotificationsRead, markNotificationRead } from '../services/db';
import { AppNotification } from '../types';
import { cn } from '../lib/utils';
import { FOCUS_ITEM, OVERLAY, STATUS_INK, Z } from './chat/studioDesign';
import { IconButton } from './ds/IconButton';

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

/** How often the bell looks for new notifications while the tab is visible (Supabase, never /api). */
export const NOTIFICATION_POLL_MS = 30_000;

/** The unread count on the bell: the danger mark with its on-colour, a ring of the page around it. */
export const BELL_COUNT = 'pointer-events-none absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--ds-danger-mark)] px-1 text-[10.5px] font-semibold tabular-nums leading-none text-[var(--ds-on-danger)] ring-2 ring-[var(--ds-canvas)]';
/**
 * The panel: the overlay surface on the popover layer. On a phone the bell sits third from the right (before
 * the profile and the menu toggle), so a panel hung from it ran off the left edge: below `sm` it is pinned to
 * the viewport instead, 16 px from each side, its top just under the bell (`--bell-top`, measured when it
 * opens; 4rem until then). From `sm` up it hangs from the bell's right edge, 22rem wide. Either way it stops
 * 1rem above the bottom of the screen and its list scrolls.
 */
export const BELL_PANEL = `fixed inset-x-4 top-[var(--bell-top,4rem)] flex max-h-[calc(100dvh-var(--bell-top,4rem)-1rem)] flex-col overflow-hidden sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[22rem] ${OVERLAY}`;
/** The overlay entrance (styles/ds-motion.css: 280 ms, fade and grow from 96 %; still under reduced motion). */
export const BELL_PANEL_ENTER = 'ds-scale-in';
/** The gap between the bell and the panel's top, in px (the `sm:mt-2` of the wider layout). */
const PANEL_GAP_PX = 8;
/** One notification row (unread rows sit on the soft accent). */
export const BELL_ROW = `flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-[var(--ds-motion-fast,120ms)] hover:bg-[var(--ds-overlay-hover)] motion-reduce:transition-none ${FOCUS_ITEM}`;

export interface NotificationBellProps {
    onNavigate: (view: string, id?: string) => void;
}

/**
 * The header's notification bell (Atlas chrome): a 44 px icon button (on a coarse pointer) with the unread
 * count, opening a panel of the latest notifications. It looks for new ones every 30 s while the tab is
 * visible and once more when the tab comes back, never while it is hidden. Escape or a click outside closes
 * the panel. The trigger is a disclosure (aria-expanded + aria-controls), not a menu: the panel is a region of
 * plain buttons, so it announces no menu semantics it does not have.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({ onNavigate }) => {
    const { user } = useAuth();
    const [notifications, setNotifications] = useState<AppNotification[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    // Where the phone panel's top goes: just under the bell, wherever the header puts it (the home page's
    // announcement line sits above the row). Measured before paint when the panel opens, and again on resize.
    const [panelTop, setPanelTop] = useState<number | null>(null);

    const loadNotifications = async () => {
        if (!user) return;
        const data = await getNotifications(user.id);
        setNotifications(data);
        setUnreadCount(data.filter(n => !n.is_read).length);
    };

    useEffect(() => {
        if (!user) return;
        void loadNotifications();
        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
        // A background tab does not poll; coming back catches up at once.
        const interval = setInterval(() => {
            if (!hidden()) void loadNotifications();
        }, NOTIFICATION_POLL_MS);
        const onVisible = () => {
            if (!hidden()) void loadNotifications();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    useLayoutEffect(() => {
        if (!isOpen) return undefined;
        const place = () => {
            const bottom = triggerRef.current?.getBoundingClientRect().bottom ?? 0;
            setPanelTop(bottom > 0 ? Math.round(bottom + PANEL_GAP_PX) : null);
        };
        place();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
    }, [isOpen]);

    // Close the panel on a click outside it or on Escape (focus goes back to the bell).
    useEffect(() => {
        if (!isOpen) return undefined;
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setIsOpen(false);
            triggerRef.current?.focus();
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKey);
        };
    }, [isOpen]);

    const handleNotificationClick = async (n: AppNotification) => {
        if (!n.is_read) {
            await markNotificationRead(n.id);
            void loadNotifications();
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

    // Monochrome icons (hue only carries meaning): a system notice is a usage warning, so it reads as one.
    const typeIcon = (n: AppNotification) => {
        if (n.type === 'like') return <Heart className="size-4" />;
        if (n.type === 'comment') return <MessageSquare className="size-4" />;
        if (n.type === 'follow') return <UserPlus className="size-4" />;
        if (n.type === 'generation') return <Sparkles className="size-4" />;
        return <AlertTriangle className={cn('size-4', STATUS_INK.attention)} />;
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
            <IconButton
                ref={triggerRef}
                label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
                title="Notifications"
                onClick={() => setIsOpen((o) => !o)}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                size="lg"
                className="relative"
            >
                <Bell className="size-[18px]" />
                {unreadCount > 0 && (
                    <span data-slot="bell-count" className={BELL_COUNT}>
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </IconButton>

            {isOpen && (
                <div
                    id={panelId}
                    role="region"
                    aria-label="Notifications"
                    data-slot="bell-panel"
                    className={cn(BELL_PANEL, Z.popover, BELL_PANEL_ENTER)}
                    style={panelTop === null ? undefined : ({ '--bell-top': `${panelTop}px` } as React.CSSProperties)}
                >
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--ds-hairline)] px-4 py-3">
                        <h3 className="m-0 text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]">Notifications</h3>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!user) return;
                                    await markAllNotificationsRead(user.id);
                                    await loadNotifications();
                                }}
                                className={`rounded-[var(--ds-radius-sm,0.25rem)] text-xs font-medium text-[var(--ds-ink)] underline-offset-4 hover:underline coarse:min-h-[var(--ds-density-touch)] ${FOCUS_ITEM}`}
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    <div className="max-h-96 min-h-0 divide-y divide-[var(--ds-hairline-soft)] overflow-y-auto overscroll-contain">
                        {notifications.length === 0 ? (
                            <p role="status" className="m-0 p-8 text-center text-[length:var(--ds-text-base)] text-[var(--ds-muted)]">
                                You&apos;re all caught up.
                            </p>
                        ) : (
                            notifications.map(n => {
                                const body = bodyText(n);
                                return (
                                    <button
                                        key={n.id}
                                        type="button"
                                        onClick={() => handleNotificationClick(n)}
                                        data-unread={!n.is_read || undefined}
                                        className={cn(BELL_ROW, !n.is_read && 'bg-[var(--ds-accent-soft)]')}
                                    >
                                        <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[var(--ds-radius-control,0.75rem)] border border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-muted)]">
                                            {typeIcon(n)}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-[length:var(--ds-text-base)] font-medium leading-snug text-[var(--ds-ink)]">{body.title}</span>
                                            {body.sub && <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--ds-muted)]">{body.sub}</span>}
                                            <span className="mt-1 block text-[11px] text-[var(--ds-muted)]">{formatWhen(n.created_at)}</span>
                                        </span>
                                        {!n.is_read && (
                                            <span className="mt-1.5 shrink-0">
                                                <span aria-hidden="true" className="block size-2 rounded-full bg-[var(--ds-ink)]" />
                                                <span className="sr-only">Unread</span>
                                            </span>
                                        )}
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

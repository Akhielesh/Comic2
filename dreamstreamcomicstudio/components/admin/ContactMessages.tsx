/**
 * Settings › Admin › Analytics › Contact (CONTACT-1): the messages people send from Settings › Contact,
 * newest first, 50 at a time. Admin-only on the server (GET /api/admin/contact-messages); loads when the
 * tab opens and on Refresh — never on a timer. Each message can be marked handled once it is answered.
 *
 * The reply-to address is whatever the sender typed. It becomes a mailto: link only when it has the shape
 * POST /api/contact accepts (shared/contactMessage.ts), so a row stored before that check, or written some
 * other way, can never add Cc, Bcc, a subject or a body to the admin's reply; otherwise it is plain text.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, Mail, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button, DENSITY, EmptyState, ErrorState, LoadingState, OVERLINE, RADIUS_PANEL, SHADOW_SOFT, StatusChip, TONE_TEXT, FOCUS_RING } from '../ds';
import { contactMessagesApi, type ContactMessage, type ContactMessagesApi } from '../../services/adminContact';
import { isContactEmail } from '../../shared/contactMessage';

const fmt = (iso: string | null): string => {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
};

type Load = 'loading' | 'ready' | 'error';

export function ContactMessages({ api = contactMessagesApi }: { api?: ContactMessagesApi }) {
  const [items, setItems] = useState<ContactMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [storageEnabled, setStorageEnabled] = useState(true);
  const [load, setLoad] = useState<Load>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [markFailed, setMarkFailed] = useState<string | null>(null);
  // Set on every mount, not only the first: React.StrictMode (dev) runs mount, unmount, mount, and a
  // ref that only ever turns false would drop every result after that and leave the list loading.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    setLoad('loading');
    setMoreFailed(false);
    try {
      const page = await api.list();
      if (!alive.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setStorageEnabled(page.storageEnabled !== false);
      setLoad('ready');
    } catch {
      if (alive.current) setLoad('error');
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await api.list(nextCursor);
      if (!alive.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...page.items.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      if (alive.current) setMoreFailed(true);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  };

  const markHandled = async (id: string) => {
    if (marking) return;
    setMarking(id);
    setMarkFailed(null);
    try {
      const res = await api.markHandled(id);
      if (!alive.current) return;
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, handled_at: res.handledAt } : m)));
    } catch {
      if (alive.current) setMarkFailed(id);
    } finally {
      if (alive.current) setMarking(null);
    }
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h3 className="m-0 text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]">Contact messages</h3>
        <p className="m-0 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">Sent from Settings › Contact, newest first. Reply from your email; mark a message handled once it’s answered.</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void refresh()} loading={load === 'loading'}>
        <RefreshCw aria-hidden="true" /> Refresh
      </Button>
    </div>
  );

  if (load === 'loading' && items.length === 0) {
    return (
      <section aria-label="Contact messages" className="space-y-3">
        {header}
        <LoadingState variant="inline" title="Loading messages…" />
      </section>
    );
  }

  if (load === 'error') {
    return (
      <section aria-label="Contact messages" className="space-y-3">
        {header}
        <ErrorState variant="inline" title="Messages didn’t load" description="The admin service didn’t answer. Nothing was changed." onRetry={() => void refresh()} />
      </section>
    );
  }

  return (
    <section aria-label="Contact messages" className="space-y-3">
      {header}
      {!storageEnabled ? (
        <EmptyState
          variant="inline"
          icon={<Inbox />}
          title="Contact messages aren’t stored yet"
          description="Apply server/sql/contact_messages.sql and give the backend its Supabase service role. Until then a send from Settings › Contact says it couldn’t be sent, and nothing is kept."
        />
      ) : items.length === 0 ? (
        <EmptyState variant="inline" icon={<Inbox />} title="No messages yet" description="Messages sent from Settings › Contact show up here, newest first." />
      ) : (
        <ul className="m-0 list-none space-y-2 p-0" aria-label="Messages">
          {items.map((m) => {
            const handled = Boolean(m.handled_at);
            return (
              <li key={m.id} data-contact-id={m.id} className={cn('min-w-0 border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-3', RADIUS_PANEL, SHADOW_SOFT)}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {isContactEmail(m.email) ? (
                    <a href={`mailto:${m.email}`} className={cn('inline-flex min-w-0 items-center gap-1.5 break-all font-medium text-[var(--ds-ink)] underline-offset-4 hover:underline coarse:py-2', DENSITY.coarse, FOCUS_RING)}>
                      <Mail aria-hidden="true" className="size-3.5 shrink-0 text-[var(--ds-muted)]" />
                      {m.email}
                    </a>
                  ) : (
                    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 break-all font-medium text-[var(--ds-ink)]">
                      {m.email}
                      <span className="text-[length:var(--ds-text-sm)] font-normal text-[var(--ds-muted)]">Not a reply address, so no Reply link.</span>
                    </span>
                  )}
                  <time dateTime={m.created_at} className="tabular-nums text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">{fmt(m.created_at)}</time>
                  <StatusChip state={handled ? 'healthy' : 'waiting'} className="ml-auto">
                    {handled ? 'Handled' : 'Open'}
                  </StatusChip>
                </div>
                <p className="m-0 mt-2 whitespace-pre-wrap break-words text-[length:var(--ds-text-base)] text-[var(--ds-ink)]">{m.message}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {handled ? (
                    <span className={OVERLINE}>Handled {fmt(m.handled_at)}</span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void markHandled(m.id)} loading={marking === m.id} disabled={marking !== null && marking !== m.id}>
                      Mark handled
                    </Button>
                  )}
                  {markFailed === m.id ? (
                    <span role="status" className={cn('text-[length:var(--ds-text-sm)]', TONE_TEXT.danger)}>Couldn’t mark it handled. Try again.</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            Load older messages
          </Button>
          {moreFailed ? <span role="status" className={cn('text-[length:var(--ds-text-sm)]', TONE_TEXT.danger)}>Older messages didn’t load. Try again.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

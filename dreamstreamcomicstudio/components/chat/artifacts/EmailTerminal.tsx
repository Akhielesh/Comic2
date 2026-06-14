import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Mail,
  Inbox,
  Search,
  Star,
  ExternalLink,
  Reply,
  Loader2,
  Copy,
  Check,
  ArrowLeft,
  RefreshCw,
  X
} from 'lucide-react';
import type { EmailInboxArtifact, EmailMessage } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact, relativeTime } from './kit';
import { fetchEmails, fetchEmailBody } from '../../../services/emailApi';

// The email "terminal" — a large, interactive inbox/unread widget rendered in chat.
//  • compact — top messages as a glance list (avatar · sender · subject · time · unread dot).
//  • detailed + WIDE (card ≥ 560px) — master-detail: scrollable message list (left) ⇄ a
//    reading pane (right) that fetches the full decoded body on demand. Search, mailbox
//    tabs (Inbox/Unread), per-message Open/Reply/Copy, and "load more" paging.
//  • detailed + narrow — the list; tapping a message swaps to a full-width reader with a
//    back button (mobile master-detail).
//
// All reads go through the AUTHENTICATED, per-connection email API (services/emailApi),
// so search/paging/body reads stay scoped to the signed-in owner — no model round-trip.
// The connection is read-only: actions (open, reply) hand off to Gmail.

const SPLIT_MIN_WIDTH = 560;
const PAGE = 25;

const enc = (s: string): string => encodeURIComponent(s || '');

/** Prefilled Gmail reply compose link (read-only connection → we hand off to Gmail). */
const replyUrl = (e: EmailMessage): string => {
  const to = e.from?.email || '';
  const subject = /^re:/i.test(e.subject || '') ? e.subject || '' : `Re: ${e.subject || ''}`;
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}`;
};

const senderName = (e: EmailMessage): string => e.from?.name || e.from?.email || '(unknown sender)';

const seededGradient = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 48% 58%), hsl(${(h + 40) % 360} 48% 46%))`;
};
const initials = (s: string): string =>
  (s || '?')
    .replace(/[<>@].*$/, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

const Avatar: React.FC<{ email: EmailMessage; size?: number }> = ({ email, size = 28 }) => {
  const name = senderName(email);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36, background: seededGradient(email.from?.email || name) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
};

// ── On-demand body reader (full decoded text), with a snippet fallback. ──────────
const useEmailBody = (
  connectionId: string,
  email: EmailMessage | undefined
): { loading: boolean; body: string | null; error: boolean } => {
  const [state, setState] = useState<{ id: string; loading: boolean; body: string | null; error: boolean }>(() => ({
    id: email?.id || '',
    loading: false,
    body: email?.body ?? null,
    error: false
  }));

  useEffect(() => {
    if (!email) return;
    if (email.body) {
      setState({ id: email.id, loading: false, body: email.body, error: false });
      return;
    }
    let active = true;
    setState({ id: email.id, loading: true, body: null, error: false });
    fetchEmailBody(connectionId, email.id)
      .then((full) => active && setState({ id: email.id, loading: false, body: full.body ?? full.snippet ?? '', error: false }))
      .catch(() => active && setState({ id: email.id, loading: false, body: null, error: true }));
    return () => {
      active = false;
    };
  }, [connectionId, email?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (email && state.id !== email.id) return { loading: true, body: null, error: false };
  return state;
};

// ── Row meta line ───────────────────────────────────────────────────────────────
const RowMeta: React.FC<{ email: EmailMessage }> = ({ email }) => (
  <span className="flex items-center gap-1.5 text-[10px] text-[var(--ds-muted)]">
    {email.starred && <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-label="Starred" />}
    {email.date && <span className="shrink-0 tabular-nums">{relativeTime(email.date)}</span>}
  </span>
);

// ── Reading pane ──────────────────────────────────────────────────────────────────
const ReaderPane: React.FC<{ connectionId: string; email: EmailMessage; onBack?: () => void }> = ({
  connectionId,
  email,
  onBack
}) => {
  const { loading, body, error } = useEmailBody(connectionId, email);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    const text = `${email.subject}\n\n${body || email.snippet || ''}`;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [email, body]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-[var(--ds-hairline-soft)] px-4 py-3">
        {onBack && (
          <button onClick={onBack} className="-ml-1 mt-0.5 shrink-0 rounded-lg p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]" aria-label="Back to list">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-[var(--ds-ink)]">{email.subject}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--ds-muted)]">
            <span className="font-medium text-[var(--ds-ink)]">{senderName(email)}</span>
            {email.from?.email && email.from.email !== senderName(email) && <span className="truncate">&lt;{email.from.email}&gt;</span>}
            {email.date && <span className="shrink-0">· {new Date(email.date).toLocaleString()}</span>}
          </p>
          {email.to && <p className="mt-0.5 truncate text-[10px] text-[var(--ds-faint)]">to {email.to}</p>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <div className="px-4 py-3">
          {loading ? (
            <div role="status" aria-label="Loading message" className="space-y-2.5">
              <div className="studio-shimmer h-3.5 w-full rounded" />
              <div className="studio-shimmer h-3.5 w-[92%] rounded" />
              <div className="studio-shimmer h-3.5 w-full rounded" />
              <div className="studio-shimmer h-3.5 w-3/4 rounded" />
            </div>
          ) : body ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-[var(--ds-ink)] opacity-90">{body}</pre>
          ) : (
            <div>
              {email.snippet && <p className="text-[13px] leading-relaxed text-[var(--ds-ink)] opacity-90">{email.snippet}</p>}
              <div className={`${email.snippet ? 'mt-3' : ''} rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-[12px] text-[var(--ds-muted)]`}>
                {error ? "Couldn't load the full message here." : 'No preview available.'}{' '}
                <a href={email.url} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--ds-accent)] hover:underline">
                  Open in Gmail ↗
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 border-t border-[var(--ds-hairline-soft)] px-3 py-2">
        <a href={email.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]">
          <ExternalLink className="h-3.5 w-3.5" /> Open
        </a>
        <a href={replyUrl(email)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]">
          <Reply className="h-3.5 w-3.5" /> Reply
        </a>
        <button onClick={copy} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
};

// ── List row ──────────────────────────────────────────────────────────────────────
const Row: React.FC<{
  email: EmailMessage;
  selected: boolean;
  onSelect: () => void;
  rowRef?: (el: HTMLButtonElement | null) => void;
}> = ({ email, selected, onSelect, rowRef }) => (
  <li role="presentation">
    <button
      type="button"
      role="option"
      aria-selected={selected}
      ref={rowRef}
      onClick={onSelect}
      className={`relative flex w-full items-start gap-2.5 py-2 pl-3.5 pr-3 text-left transition-colors duration-150 ${
        selected ? 'bg-[var(--ds-well)]' : 'hover:bg-[var(--ds-hover)]'
      }`}
    >
      {selected && <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-r-full bg-[var(--ds-accent)]" />}
      {email.unread && <span aria-hidden className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[var(--ds-accent)]" />}
      <Avatar email={email} size={30} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={`truncate text-[12px] ${email.unread ? 'font-semibold text-[var(--ds-ink)]' : 'font-medium text-[var(--ds-ink)]'}`}>{senderName(email)}</span>
          <RowMeta email={email} />
        </span>
        <span className={`mt-0.5 block truncate text-[12px] ${email.unread ? 'font-medium text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]'}`}>{email.subject}</span>
        {email.snippet && <span className="mt-0.5 block truncate text-[11px] text-[var(--ds-faint)]">{email.snippet}</span>}
      </span>
    </button>
  </li>
);

export const EmailTerminal: React.FC<{ data: EmailInboxArtifact }> = ({ data }) => {
  const compact = useCompact();
  const connectionId = data.connectionId;

  const [box, setBox] = useState<'inbox' | 'unread'>(data.box === 'unread' ? 'unread' : 'inbox');
  const [query, setQuery] = useState(data.query || '');
  const [emails, setEmails] = useState<EmailMessage[]>(data.emails || []);
  const [cursor, setCursor] = useState<string | null>(data.nextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(data.emails?.[0]?.id ?? null);
  const [mobileReading, setMobileReading] = useState(false);

  // Load a fresh page for the current box/query (server-scoped to this connection).
  const load = useCallback(
    async (append: boolean) => {
      const q = query.trim();
      const effectiveQ = box === 'unread' && q ? `is:unread ${q}` : q;
      append ? setLoadingMore(true) : setLoading(true);
      setErr(null);
      try {
        const res = await fetchEmails(connectionId, {
          box: q ? 'search' : box,
          q: effectiveQ,
          max: PAGE,
          cursor: append ? cursor : null
        });
        setEmails((prev) => (append ? [...prev, ...res.emails] : res.emails));
        setCursor(res.nextCursor);
        if (!append) setSelectedId(res.emails[0]?.id ?? null);
      } catch (e) {
        setErr((e as Error)?.message || 'Could not load messages');
      } finally {
        append ? setLoadingMore(false) : setLoading(false);
      }
    },
    [box, query, cursor, connectionId]
  );

  // Debounced reload when the mailbox tab or search changes (skips the initial render —
  // the artifact already shipped the first page).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => void load(false), 320);
    return () => clearTimeout(t);
  }, [box, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchBox = (next: 'inbox' | 'unread') => {
    if (next === box) return;
    setQuery('');
    setBox(next);
  };

  // ── Width-aware split (measure the card, like NewsDigest). ──────────────────────
  const shellRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (compact) return;
    const el = shellRef.current;
    if (!el) return;
    const update = (w: number) => setWide(w >= SPLIT_MIN_WIDTH);
    update(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (typeof w === 'number') update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact]);

  const selectedIndex = Math.max(0, emails.findIndex((e) => e.id === selectedId));
  const selected = emails[selectedIndex];
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const unreadCount = useMemo(() => emails.filter((e) => e.unread).length, [emails]);

  const moveSelection = (delta: number) => {
    if (!emails.length) return;
    const next = Math.min(emails.length - 1, Math.max(0, selectedIndex + delta));
    if (next === selectedIndex) return;
    setSelectedId(emails[next].id);
    rowRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
  };
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    }
  };

  const accountLabel = data.accountLabel || data.account || 'Gmail';
  const title = box === 'unread' ? 'Unread' : 'Inbox';

  // ── Compact glance ──────────────────────────────────────────────────────────────
  if (compact) {
    return (
      <Surface
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
            <SurfaceTitle>{title}</SurfaceTitle>
          </span>
        }
        right={<SurfaceSubtitle>{box === 'unread' ? `${emails.length} unread` : `${unreadCount} unread`}</SurfaceSubtitle>}
      >
        <ul className="studio-stagger divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {emails.slice(0, 5).map((e) => (
            <li key={e.id}>
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--ds-well)]">
                <Avatar email={e} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={`truncate text-[12px] ${e.unread ? 'font-semibold' : 'font-medium'} text-[var(--ds-ink)]`}>{senderName(e)}</span>
                    {e.date && <span className="shrink-0 text-[9px] text-[var(--ds-muted)] tabular-nums">{relativeTime(e.date)}</span>}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--ds-muted)]">{e.subject}</span>
                </span>
                {e.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" />}
              </a>
            </li>
          ))}
          {emails.length === 0 && <li className="px-3 py-4 text-center text-[12px] text-[var(--ds-muted)]">No messages.</li>}
        </ul>
      </Surface>
    );
  }

  // ── Header controls (search + tabs) ─────────────────────────────────────────────
  const controls = (
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
      <div className="flex items-center gap-1.5">
        {(['inbox', 'unread'] as const).map((b) => {
          const active = b === box && !query.trim();
          return (
            <button
              key={b}
              onClick={() => switchBox(b)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]'
                  : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
              }`}
            >
              {b === 'unread' ? <Mail className="h-3 w-3" /> : <Inbox className="h-3 w-3" />}
              {b === 'unread' ? 'Unread' : 'Inbox'}
            </button>
          );
        })}
        <button
          onClick={() => void load(false)}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-faint)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search mail (from:, subject:, has:attachment…)"
          className="w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] py-1.5 pl-8 pr-7 text-[12px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/40"
        />
        {query && (
          <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ds-faint)] hover:text-[var(--ds-ink)]" aria-label="Clear search">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );

  const listEl = (
    <ul
      role="listbox"
      aria-label="Messages"
      className={`min-h-0 divide-y divide-[var(--ds-hairline-soft)] overflow-y-auto overscroll-auto [scrollbar-width:thin] ${
        wide ? 'w-[42%] min-w-[220px] shrink-0 border-r border-[var(--ds-hairline-soft)]' : 'flex-1'
      }`}
    >
      {emails.map((e, i) => (
        <Row
          key={e.id}
          email={e}
          selected={wide && i === selectedIndex}
          rowRef={(el) => {
            rowRefs.current[i] = el;
          }}
          onSelect={() => {
            setSelectedId(e.id);
            if (!wide) setMobileReading(true);
          }}
        />
      ))}
      {emails.length === 0 && !loading && (
        <li className="px-3 py-10 text-center text-[12px] text-[var(--ds-muted)]">
          {err ? err : query.trim() ? `No messages match “${query.trim()}”.` : 'No messages here.'}
        </li>
      )}
      {cursor && (
        <li>
          <button
            onClick={() => void load(true)}
            disabled={loadingMore}
            className="flex w-full items-center justify-center gap-1.5 py-2 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-60"
          >
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </li>
      )}
    </ul>
  );

  const headerRight = (
    <span className="flex items-center gap-1.5">
      {loading && <Loader2 className="h-3 w-3 animate-spin text-[var(--ds-muted)]" />}
      <SurfaceSubtitle>{box === 'unread' ? `${emails.length} unread` : `${unreadCount} unread · ${emails.length}`}</SurfaceSubtitle>
    </span>
  );

  return (
    <div ref={shellRef} className="flex h-full max-h-full min-h-0 flex-col">
      <Surface
        className="flex min-h-0 flex-1 flex-col"
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <Mail className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" />
            <SurfaceTitle>{title}</SurfaceTitle>
            <span className="truncate text-[11px] text-[var(--ds-muted)]">· {accountLabel}</span>
          </span>
        }
        right={headerRight}
      >
        {controls}
        <div
          onKeyDown={onListKeyDown}
          className={`flex min-h-0 flex-[1_1_520px] border-t border-[var(--ds-hairline-soft)] ${loading ? 'opacity-60' : ''}`}
        >
          {wide ? (
            <>
              {listEl}
              {selected ? (
                <ReaderPane connectionId={connectionId} email={selected} />
              ) : (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-[var(--ds-muted)]">
                  Select a message to read it here.
                </div>
              )}
            </>
          ) : mobileReading && selected ? (
            <ReaderPane connectionId={connectionId} email={selected} onBack={() => setMobileReading(false)} />
          ) : (
            listEl
          )}
        </div>
      </Surface>
    </div>
  );
};

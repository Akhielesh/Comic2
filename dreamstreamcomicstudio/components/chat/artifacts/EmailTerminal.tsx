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
  X,
  Paperclip,
  Download,
  Image as ImageIcon,
  Eye,
  EyeOff,
  SlidersHorizontal
} from 'lucide-react';
import type { EmailInboxArtifact, EmailMessage, EmailAttachment, EmailCategory } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact, relativeTime } from './kit';
import { fetchEmails, fetchEmailBody, fetchAttachment } from '../../../services/emailApi';
import { EmailHtmlView, b64urlToDataUrl, hasRemoteImages } from './EmailHtmlView';

// The premium email "terminal" — a smart, interactive inbox rendered in chat or on a board.
//  • Category tabs (Primary by default → hides promotions/social/updates) + filters
//    (Unread / Starred / Attachments). Free-text search spans ALL mail.
//  • Master-detail when wide: list ⇄ a reading pane that renders the email's TRUE HTML
//    (sandboxed iframe, inline images resolved, remote images one-click, real links) with
//    an attachments rail; plain-text fallback otherwise.
//  • Multi-account aggregation: when the artifact is `aggregated`, the list merges every
//    connected Gmail account (each row tagged) and reads use the row's own connection.
//  • Smart compact glance. All reads go through the AUTHENTICATED per-connection email API.

const SPLIT_MIN_WIDTH = 560;
const PAGE = 25;
const MAX_INLINE_IMAGES = 24;

const enc = (s: string): string => encodeURIComponent(s || '');

const replyUrl = (e: EmailMessage): string => {
  const to = e.from?.email || '';
  const subject = /^re:/i.test(e.subject || '') ? e.subject || '' : `Re: ${e.subject || ''}`;
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}`;
};

const senderName = (e: EmailMessage): string => e.from?.name || e.from?.email || '(unknown sender)';

const CATEGORIES: { id: EmailCategory; label: string }[] = [
  { id: 'primary', label: 'Primary' },
  { id: 'social', label: 'Social' },
  { id: 'promotions', label: 'Promotions' },
  { id: 'updates', label: 'Updates' },
  { id: 'forums', label: 'Forums' }
];
const CAT_COLOR: Record<EmailCategory, string> = {
  primary: 'var(--ds-accent)',
  social: '#3b82f6',
  promotions: '#10b981',
  updates: '#f59e0b',
  forums: '#8b5cf6'
};

const formatBytes = (n?: number): string => {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

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

const Avatar: React.FC<{ email: EmailMessage; size?: number }> = ({ email, size = 28 }) => (
  <span
    className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
    style={{ width: size, height: size, fontSize: size * 0.36, background: seededGradient(email.from?.email || senderName(email)) }}
    aria-hidden
  >
    {initials(senderName(email))}
  </span>
);

// ── Full-message reader (HTML true-form + attachments + inline images). ──────────
interface FullState {
  id: string;
  loading: boolean;
  full: EmailMessage | null;
  error: boolean;
}
const useEmailFull = (connectionId: string, email: EmailMessage | undefined): FullState => {
  const [state, setState] = useState<FullState>(() => ({ id: email?.id || '', loading: false, full: email?.html !== undefined ? email : null, error: false }));
  useEffect(() => {
    if (!email) return;
    // Already hydrated (gallery demo / pre-loaded) → use as-is.
    if (email.html !== undefined && email.html !== null) {
      setState({ id: email.id, loading: false, full: email, error: false });
      return;
    }
    let active = true;
    setState({ id: email.id, loading: true, full: null, error: false });
    fetchEmailBody(connectionId, email.id)
      .then((full) => active && setState({ id: email.id, loading: false, full, error: false }))
      .catch(() => active && setState({ id: email.id, loading: false, full: null, error: true }));
    return () => {
      active = false;
    };
  }, [connectionId, email?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (email && state.id !== email.id) return { id: email.id, loading: true, full: null, error: false };
  return state;
};

const AttachmentChip: React.FC<{ connectionId: string; messageId: string; att: EmailAttachment }> = ({ connectionId, messageId, att }) => {
  const [busy, setBusy] = useState(false);
  const isImage = att.mimeType.startsWith('image/');
  const download = async () => {
    setBusy(true);
    try {
      const res = await fetchAttachment(connectionId, messageId, att.attachmentId);
      const url = b64urlToDataUrl(res.data, att.mimeType);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename || 'attachment';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* ignore — best effort */
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      title={`${att.filename}${att.size ? ` · ${formatBytes(att.size)}` : ''}`}
      className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)] disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : isImage ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" /> : <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />}
      <span className="truncate">{att.filename}</span>
      {att.size ? <span className="shrink-0 text-[var(--ds-faint)]">{formatBytes(att.size)}</span> : null}
      <Download className="h-3 w-3 shrink-0 text-[var(--ds-faint)]" />
    </button>
  );
};

const ReaderPane: React.FC<{ connectionId: string; email: EmailMessage; onBack?: () => void }> = ({ connectionId, email, onBack }) => {
  const { loading, full, error } = useEmailFull(connectionId, email);
  const [copied, setCopied] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const [cidMap, setCidMap] = useState<Record<string, string>>({});

  const html = full?.html || null;
  const text = full?.text || full?.body || null;
  const attachments = full?.attachments || [];
  const downloadable = attachments.filter((a) => !a.inline);
  const inline = attachments.filter((a) => a.inline && a.contentId);
  const remotePossible = !!html && hasRemoteImages(html);

  // Reset per-message view state + resolve inline (cid:) images to data URLs.
  useEffect(() => {
    setShowRemote(false);
    setCidMap({});
    if (!inline.length) return;
    let active = true;
    Promise.all(
      inline.slice(0, MAX_INLINE_IMAGES).map(async (a) => {
        try {
          const res = await fetchAttachment(connectionId, email.id, a.attachmentId);
          return [a.contentId as string, b64urlToDataUrl(res.data, a.mimeType)] as const;
        } catch {
          return null;
        }
      })
    ).then((pairs) => {
      if (!active) return;
      const map: Record<string, string> = {};
      for (const p of pairs) if (p) map[p[0]] = p[1];
      setCidMap(map);
    });
    return () => {
      active = false;
    };
  }, [connectionId, email.id, full?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = useCallback(() => {
    const t = `${email.subject}\n\n${text || email.snippet || ''}`;
    void navigator.clipboard?.writeText(t).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [email, text]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-[var(--ds-hairline-soft)] px-4 py-3">
        {onBack && (
          <button onClick={onBack} className="-ml-1 mt-0.5 shrink-0 rounded-lg p-1 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]" aria-label="Back to list">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <Avatar email={email} size={34} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-[var(--ds-ink)]">{email.subject}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--ds-muted)]">
            <span className="font-medium text-[var(--ds-ink)]">{senderName(email)}</span>
            {email.from?.email && email.from.email !== senderName(email) && <span className="truncate">&lt;{email.from.email}&gt;</span>}
            {email.account && <span className="rounded bg-[var(--ds-well)] px-1 text-[9px]">{email.account}</span>}
            {email.date && <span className="shrink-0">· {new Date(email.date).toLocaleString()}</span>}
          </p>
          {email.to && <p className="mt-0.5 truncate text-[10px] text-[var(--ds-faint)]">to {email.to}</p>}
        </div>
        {remotePossible && (
          <button
            onClick={() => setShowRemote((v) => !v)}
            title={showRemote ? 'Hide remote images' : 'Show remote images (senders may track opens)'}
            className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[10px] font-medium text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            {showRemote ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showRemote ? 'Hide images' : 'Show images'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        {loading ? (
          <div role="status" aria-label="Loading message" className="space-y-2.5 px-4 py-3">
            <div className="studio-shimmer h-3.5 w-full rounded" />
            <div className="studio-shimmer h-3.5 w-[92%] rounded" />
            <div className="studio-shimmer h-40 w-full rounded-lg" />
            <div className="studio-shimmer h-3.5 w-3/4 rounded" />
          </div>
        ) : html ? (
          <div className="px-3 py-3">
            <EmailHtmlView html={html} cidMap={cidMap} showRemote={showRemote} />
          </div>
        ) : text ? (
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-sans text-[13px] leading-relaxed text-[var(--ds-ink)] opacity-90">{text}</pre>
        ) : (
          <div className="px-4 py-3">
            {email.snippet && <p className="text-[13px] leading-relaxed text-[var(--ds-ink)] opacity-90">{email.snippet}</p>}
            <div className={`${email.snippet ? 'mt-3' : ''} rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-[12px] text-[var(--ds-muted)]`}>
              {error ? "Couldn't load the full message here." : 'No preview available.'}{' '}
              <a href={email.url} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--ds-accent)] hover:underline">
                Open in Gmail ↗
              </a>
            </div>
          </div>
        )}

        {downloadable.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-[var(--ds-hairline-soft)] px-4 py-2.5">
            <span className="flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-faint)]">
              <Paperclip className="h-3 w-3" /> {downloadable.length} attachment{downloadable.length === 1 ? '' : 's'}
            </span>
            {downloadable.map((a) => (
              <AttachmentChip key={a.attachmentId} connectionId={connectionId} messageId={email.id} att={a} />
            ))}
          </div>
        )}
      </div>

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
const Row: React.FC<{ email: EmailMessage; selected: boolean; showAccount: boolean; onSelect: () => void; rowRef?: (el: HTMLButtonElement | null) => void }> = ({
  email,
  selected,
  showAccount,
  onSelect,
  rowRef
}) => (
  <li role="presentation">
    <button
      type="button"
      role="option"
      aria-selected={selected}
      ref={rowRef}
      onClick={onSelect}
      className={`relative flex w-full items-start gap-2.5 py-2 pl-3.5 pr-3 text-left transition-colors duration-150 ${selected ? 'bg-[var(--ds-well)]' : 'hover:bg-[var(--ds-hover)]'}`}
    >
      {selected && <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-r-full bg-[var(--ds-accent)]" />}
      {email.unread && <span aria-hidden className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[var(--ds-accent)]" />}
      <Avatar email={email} size={30} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={`truncate text-[12px] text-[var(--ds-ink)] ${email.unread ? 'font-semibold' : 'font-medium'}`}>{senderName(email)}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-[var(--ds-muted)]">
            {email.hasAttachments && <Paperclip className="h-3 w-3" aria-label="Has attachments" />}
            {email.starred && <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-label="Starred" />}
            {email.date && <span className="tabular-nums">{relativeTime(email.date)}</span>}
          </span>
        </span>
        <span className={`mt-0.5 block truncate text-[12px] ${email.unread ? 'font-medium text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]'}`}>{email.subject}</span>
        <span className="mt-0.5 flex items-center gap-1.5">
          {email.category && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CAT_COLOR[email.category] }} title={email.category} />}
          {showAccount && email.account && <span className="shrink-0 truncate text-[10px] text-[var(--ds-faint)]">{email.account}</span>}
          {email.snippet && <span className="truncate text-[11px] text-[var(--ds-faint)]">{email.snippet}</span>}
        </span>
      </span>
    </button>
  </li>
);

type FilterState = { unread: boolean; starred: boolean; attachments: boolean };

export const EmailTerminal: React.FC<{ data: EmailInboxArtifact }> = ({ data }) => {
  const compact = useCompact();
  const accounts = useMemo(
    () => (data.aggregated && data.accounts?.length ? data.accounts : [{ connectionId: data.connectionId, account: data.account || '', label: data.accountLabel }]),
    [data]
  );
  const aggregated = !!data.aggregated && accounts.length > 1;

  const [category, setCategory] = useState<EmailCategory | 'all'>(data.category ?? 'primary');
  const [filters, setFilters] = useState<FilterState>({ unread: data.box === 'unread', starred: false, attachments: false });
  const [query, setQuery] = useState(data.query || '');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  const [emails, setEmails] = useState<EmailMessage[]>(data.emails || []);
  const [cursor, setCursor] = useState<string | null>(aggregated ? null : data.nextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(data.emails?.[0]?.id ?? null);
  const [mobileReading, setMobileReading] = useState(false);

  // Build the Gmail query from the active category + filters + free-text search.
  const buildQuery = useCallback((): string => {
    const parts: string[] = [];
    const q = query.trim();
    if (q) parts.push(q); // free text searches ALL mail
    else if (category !== 'all') parts.push(`category:${category}`);
    if (filters.unread) parts.push('is:unread');
    if (filters.starred) parts.push('is:starred');
    if (filters.attachments) parts.push('has:attachment');
    return parts.join(' ');
  }, [query, category, filters]);

  const load = useCallback(
    async (append: boolean) => {
      const q = buildQuery();
      const targets = (accountFilter === 'all' ? accounts : accounts.filter((a) => a.connectionId === accountFilter));
      append ? setLoadingMore(true) : setLoading(true);
      setErr(null);
      try {
        const perAccount = await Promise.all(
          targets.map((t) =>
            fetchEmails(t.connectionId, { box: q ? 'search' : data.box === 'unread' ? 'unread' : 'inbox', q, max: PAGE, cursor: append && !aggregated ? cursor : null })
              .then((r) => ({ t, r }))
              .catch(() => ({ t, r: { box: data.box, emails: [] as EmailMessage[], nextCursor: null } }))
          )
        );
        const tagged = perAccount.flatMap(({ t, r }) =>
          r.emails.map((e) => ({ ...e, connectionId: t.connectionId, account: aggregated ? t.account || t.label || '' : e.account }))
        );
        const merged = aggregated
          ? tagged.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          : tagged;
        setEmails((prev) => (append ? [...prev, ...merged] : merged));
        // Paging is single-account only (cross-account cursors don't merge cleanly).
        setCursor(aggregated ? null : perAccount[0]?.r.nextCursor ?? null);
        if (!append) setSelectedId(merged[0]?.id ?? null);
      } catch (e) {
        setErr((e as Error)?.message || 'Could not load messages');
      } finally {
        append ? setLoadingMore(false) : setLoading(false);
      }
    },
    [buildQuery, accounts, accountFilter, aggregated, cursor, data.box]
  );

  // Debounced reload when category / filters / search / account change (skip first render —
  // the artifact already shipped the first page).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => void load(false), 300);
    return () => clearTimeout(t);
  }, [category, filters, query, accountFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Width-aware split. ──────────────────────────────────────────────────────────
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
  const selectedConnId = selected?.connectionId || data.connectionId;
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

  const accountLabel = aggregated ? `${accounts.length} accounts` : data.accountLabel || data.account || 'Gmail';
  const title = filters.unread && category === 'primary' && !query ? 'Unread' : 'Inbox';

  // ── Compact glance (smart: category dot, unread, attachment). ───────────────────
  if (compact) {
    return (
      <Surface
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
            <SurfaceTitle>{title}</SurfaceTitle>
          </span>
        }
        right={<SurfaceSubtitle>{unreadCount ? `${unreadCount} unread` : `${emails.length}`}</SurfaceSubtitle>}
      >
        <ul className="studio-stagger divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {emails.slice(0, 6).map((e) => (
            <li key={`${e.connectionId || ''}:${e.id}`}>
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--ds-well)]">
                {e.category && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CAT_COLOR[e.category] }} />}
                <Avatar email={e} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={`truncate text-[12px] text-[var(--ds-ink)] ${e.unread ? 'font-semibold' : 'font-medium'}`}>{senderName(e)}</span>
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

  const filterChip = (key: keyof FilterState, label: string, icon: React.ReactNode) => {
    const on = filters[key];
    return (
      <button
        onClick={() => setFilters((f) => ({ ...f, [key]: !f[key] }))}
        aria-pressed={on}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
          on ? 'border-transparent bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
        }`}
      >
        {icon}
        {label}
      </button>
    );
  };

  const controls = (
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
      {/* Category tabs */}
      <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {CATEGORIES.map((c) => {
          const active = c.id === category && !query.trim();
          return (
            <button
              key={c.id}
              onClick={() => {
                setQuery('');
                setCategory(c.id);
              }}
              aria-pressed={active}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                active ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: CAT_COLOR[c.id] }} />
              {c.label}
            </button>
          );
        })}
        <button
          onClick={() => setShowFilters((v) => !v)}
          title="Filters"
          aria-label="Filters"
          aria-pressed={showFilters}
          className={`ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border transition-colors ${
            showFilters || filters.unread || filters.starred || filters.attachments
              ? 'border-transparent bg-[var(--ds-accent)] text-white'
              : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void load(false)}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Filters row (expands) — quick toggles + account filter when aggregated */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filterChip('unread', 'Unread', <Mail className="h-3 w-3" />)}
          {filterChip('starred', 'Starred', <Star className="h-3 w-3" />)}
          {filterChip('attachments', 'Attachments', <Paperclip className="h-3 w-3" />)}
          {aggregated && (
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="ml-auto rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-muted)] outline-none"
            >
              <option value="all">All accounts</option>
              {accounts.map((a) => (
                <option key={a.connectionId} value={a.connectionId}>{a.account || a.label || a.connectionId.slice(0, 6)}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-faint)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all mail (from:, subject:, has:attachment…)"
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
      className={`min-h-0 divide-y divide-[var(--ds-hairline-soft)] overflow-y-auto overscroll-auto [scrollbar-width:thin] ${wide ? 'w-[42%] min-w-[230px] shrink-0 border-r border-[var(--ds-hairline-soft)]' : 'flex-1'}`}
    >
      {emails.map((e, i) => (
        <Row
          key={`${e.connectionId || ''}:${e.id}`}
          email={e}
          showAccount={aggregated}
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
          {err ? err : query.trim() ? `No messages match “${query.trim()}”.` : 'Nothing here — try another category.'}
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
      <SurfaceSubtitle>{unreadCount ? `${unreadCount} unread · ${emails.length}` : `${emails.length}`}</SurfaceSubtitle>
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
        <div onKeyDown={onListKeyDown} className={`flex min-h-0 flex-[1_1_540px] border-t border-[var(--ds-hairline-soft)] ${loading ? 'opacity-60' : ''}`}>
          {wide ? (
            <>
              {listEl}
              {selected ? (
                <ReaderPane connectionId={selectedConnId} email={selected} />
              ) : (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-[var(--ds-muted)]">Select a message to read it here.</div>
              )}
            </>
          ) : mobileReading && selected ? (
            <ReaderPane connectionId={selectedConnId} email={selected} onBack={() => setMobileReading(false)} />
          ) : (
            listEl
          )}
        </div>
      </Surface>
    </div>
  );
};

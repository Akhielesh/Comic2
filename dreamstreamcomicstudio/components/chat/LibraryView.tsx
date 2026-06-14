import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, LayoutGrid, List, FileText, Download, ExternalLink, MessageSquare,
  Sparkles, Upload, X, ImageOff, ArrowUpRight
} from 'lucide-react';
import type { ChatSession } from '../../services/chatStorage';
import {
  collectLibraryItems, formatBytes, formatModified,
  type LibraryItem, type LibraryItemKind, type LibraryItemOrigin
} from '../../services/chatLibrary';
import {
  CANVAS_BG, GLASS, HAIRLINE, MUTED, INK, LABEL, TRANSITION, SHADOW_SOFT,
  HEADING, PILL, ACCENT_TEXT, ACCENT_SOFT_BG, HOVER_LIFT, RADIUS_PANEL
} from './studioDesign';

interface LibraryViewProps {
  sessions: ChatSession[];
  /** Jump back to the conversation an item came from. */
  onOpenSource: (sessionId: string) => void;
  /** Start a fresh chat with this item attached to the composer. */
  onUseInChat: (item: LibraryItem) => void;
  /** Sidebar toggle, rendered into this view's own header (no generic strip). */
  sidebarControl?: React.ReactNode;
}

type KindTab = 'all' | LibraryItemKind;
type OriginFilter = 'all' | LibraryItemOrigin;

const KIND_TABS: { value: KindTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'file', label: 'Files' }
];

const ORIGIN_FILTERS: { value: OriginFilter; label: string; icon: React.FC<{ className?: string }> }[] = [
  { value: 'all', label: 'All sources', icon: LayoutGrid },
  { value: 'upload', label: 'Uploads', icon: Upload },
  { value: 'generated', label: 'Generated', icon: Sparkles }
];

const isPreviewable = (item: LibraryItem): boolean =>
  item.kind === 'image' || (item.mimeType || '').includes('pdf');

const OriginBadge: React.FC<{ origin: LibraryItemOrigin }> = ({ origin }) => {
  const generated = origin === 'generated';
  const Icon = generated ? Sparkles : Upload;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        generated ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT}` : `bg-[var(--ds-well)] ${MUTED}`
      }`}
      title={generated ? 'Generated in a chat' : 'Uploaded by you'}
    >
      <Icon className="w-3 h-3" /> {generated ? 'Generated' : 'Upload'}
    </span>
  );
};

// A small file glyph for non-image assets, labelled with the extension.
const FileGlyph: React.FC<{ name: string; className?: string }> = ({ name, className = '' }) => {
  const ext = (name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return (
    <div className={`flex flex-col items-center justify-center gap-1 text-[var(--ds-muted)] ${className}`}>
      <FileText className="w-7 h-7" />
      {ext && <span className="text-[9px] font-semibold tracking-wide">{ext}</span>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lightbox — calm-studio preview overlay for a single image / PDF.
// ---------------------------------------------------------------------------

const Lightbox: React.FC<{
  item: LibraryItem;
  onClose: () => void;
  onOpenSource: (id: string) => void;
  onUseInChat: (item: LibraryItem) => void;
}> = ({ item, onClose, onOpenSource, onUseInChat }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isPdf = (item.mimeType || '').includes('pdf');
  const remote = !item.url.startsWith('data:');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-white">{item.name}</span>
          <span className="block truncate text-[11px] text-white/60">
            {item.sessionTitle} · {formatModified(item.createdAt)}
          </span>
        </span>
        <button
          onClick={() => onUseInChat(item)}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-white bg-white/10 hover:bg-white/20 transition-colors"
          title="Start a new chat with this attached"
        >
          <MessageSquare className="w-3.5 h-3.5" /> Use in chat
        </button>
        <button
          onClick={() => onOpenSource(item.sessionId)}
          className="hidden sm:flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-white bg-white/10 hover:bg-white/20 transition-colors"
          title="Open the chat this came from"
        >
          <ArrowUpRight className="w-3.5 h-3.5" /> Open chat
        </button>
        <a
          href={item.url}
          download={item.name}
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 rounded-lg text-white bg-white/10 hover:bg-white/20 transition-colors"
          title="Download"
        >
          <Download className="w-4 h-4" />
        </a>
        {remote && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 rounded-lg text-white bg-white/10 hover:bg-white/20 transition-colors"
            title="Open original"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
        <button onClick={onClose} className="p-2 rounded-lg text-white bg-white/10 hover:bg-white/20 transition-colors" title="Close (Esc)">
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* Stage */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-3 sm:p-6" onClick={(e) => e.stopPropagation()}>
        {isPdf ? (
          <iframe title={item.name} src={item.url} className="w-full h-full rounded-xl border-0 bg-white" />
        ) : (
          <img src={item.url} alt={item.name} className="max-w-full max-h-full object-contain rounded-xl shadow-2xl" />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Thumbnail (shared by grid + list)
// ---------------------------------------------------------------------------

const Thumb: React.FC<{ item: LibraryItem; size: 'grid' | 'row' }> = ({ item, size }) => {
  const [broken, setBroken] = useState(false);
  const box = size === 'grid' ? 'w-full aspect-square' : 'w-10 h-10 shrink-0';
  if (item.kind === 'image' && !broken) {
    return (
      <img
        src={item.thumbnail || item.url}
        alt={item.name}
        loading="lazy"
        onError={() => setBroken(true)}
        className={`${box} object-cover ${size === 'grid' ? '' : 'rounded-lg'} bg-[var(--ds-well)]`}
      />
    );
  }
  return (
    <div className={`${box} ${size === 'grid' ? '' : 'rounded-lg'} bg-[var(--ds-well)] flex items-center justify-center`}>
      {item.kind === 'image' ? <ImageOff className="w-6 h-6 text-[var(--ds-faint)]" /> : <FileGlyph name={item.name} />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const LibraryView: React.FC<LibraryViewProps> = ({ sessions, onOpenSource, onUseInChat, sidebarControl }) => {
  const allItems = useMemo(() => collectLibraryItems(sessions), [sessions]);
  const [kind, setKind] = useState<KindTab>('all');
  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>(() => {
    try { return window.localStorage.getItem('ds_library_layout') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const [preview, setPreview] = useState<LibraryItem | null>(null);

  const setLayoutPersist = (v: 'grid' | 'list') => {
    setLayout(v);
    try { window.localStorage.setItem('ds_library_layout', v); } catch { /* private mode */ }
  };

  const counts = useMemo(
    () => ({
      all: allItems.length,
      image: allItems.filter((i) => i.kind === 'image').length,
      file: allItems.filter((i) => i.kind === 'file').length
    }),
    [allItems]
  );

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems.filter((i) => {
      if (kind !== 'all' && i.kind !== kind) return false;
      if (origin !== 'all' && i.origin !== origin) return false;
      if (q && !(`${i.name} ${i.sessionTitle}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [allItems, kind, origin, query]);

  const open = (item: LibraryItem) => {
    if (isPreviewable(item)) setPreview(item);
    else window.open(item.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className={`flex flex-col h-full min-h-0 ${CANVAS_BG}`}>
      {/* Header */}
      <div className={`relative z-20 px-3 sm:px-6 pt-3 sm:pt-5 pb-3 border-b border-[var(--ds-hairline)] ${GLASS}`}>
        <div className="flex items-center gap-3">
          {sidebarControl}
          <h1 className={`text-xl sm:text-2xl ${HEADING}`}>Library</h1>
          <span className={`text-[11px] ${MUTED} hidden sm:inline`}>{counts.all} item{counts.all === 1 ? '' : 's'}</span>
          <div className="ml-auto relative w-40 sm:w-72">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${MUTED}`} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search library"
              className={`w-full ${PILL} pl-9 pr-3 py-1.5 text-[13px] ${INK} placeholder:text-[var(--ds-muted)] outline-none focus:bg-[var(--ds-surface)]`}
            />
          </div>
        </div>

        {/* Tabs + filters + layout toggle */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <div className={`inline-flex items-center gap-0.5 p-0.5 rounded-full ${HAIRLINE} bg-[var(--ds-well)]`}>
            {KIND_TABS.map((t) => {
              const active = kind === t.value;
              const n = counts[t.value];
              return (
                <button
                  key={t.value}
                  onClick={() => setKind(t.value)}
                  className={`rounded-full px-3 py-1 text-[12px] font-medium ${TRANSITION} ${
                    active ? `bg-[var(--ds-raised)] ${INK} ${SHADOW_SOFT}` : `${MUTED} hover:text-[var(--ds-ink)]`
                  }`}
                >
                  {t.label} <span className={active ? ACCENT_TEXT : ''}>{n}</span>
                </button>
              );
            })}
          </div>

          <div className="hidden sm:flex items-center gap-1">
            {ORIGIN_FILTERS.map(({ value, label, icon: Icon }) => {
              const active = origin === value;
              return (
                <button
                  key={value}
                  onClick={() => setOrigin(value)}
                  className={`flex items-center gap-1.5 text-[11px] font-medium ${PILL} px-2.5 py-1 ${
                    active ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT} border-[#D97757]/30` : `${MUTED} hover:bg-[var(--ds-hover)]`
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => setLayoutPersist('grid')}
              className={`p-1.5 rounded-lg ${TRANSITION} ${layout === 'grid' ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT}` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
              title="Grid view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setLayoutPersist('list')}
              className={`p-1.5 rounded-lg ${TRANSITION} ${layout === 'list' ? `${ACCENT_SOFT_BG} ${ACCENT_TEXT}` : `${MUTED} hover:bg-[var(--ds-hover)]`}`}
              title="List view"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] px-3 sm:px-6 py-4">
        {items.length === 0 ? (
          <div className="h-full min-h-[50vh] flex flex-col items-center justify-center text-center px-6">
            <div className={`w-14 h-14 rounded-2xl ${GLASS} ${HAIRLINE} flex items-center justify-center mb-3`}>
              <LayoutGrid className={`w-6 h-6 ${ACCENT_TEXT}`} />
            </div>
            <h2 className={`text-lg ${HEADING} mb-1`}>
              {allItems.length === 0 ? 'Your library is empty' : 'Nothing matches'}
            </h2>
            <p className={`${MUTED} text-sm max-w-sm`}>
              {allItems.length === 0
                ? 'Files you attach and images generated in your chats are collected here automatically.'
                : 'Try a different tab, source filter, or search term.'}
            </p>
          </div>
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {items.map((item) => (
              <div
                key={item.id}
                className={`group relative overflow-hidden ${RADIUS_PANEL} ${HAIRLINE} bg-[var(--ds-surface-soft)] ${SHADOW_SOFT} ${TRANSITION} hover:bg-[var(--ds-surface)] ${HOVER_LIFT} cursor-pointer`}
                onClick={() => open(item)}
              >
                <Thumb item={item} size="grid" />
                {/* hover action overlay */}
                <div className="absolute inset-x-0 top-0 flex justify-end gap-1 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-black/40 to-transparent">
                  <button
                    onClick={(e) => { e.stopPropagation(); onUseInChat(item); }}
                    className="p-1.5 rounded-lg text-white bg-black/40 hover:bg-black/60 transition-colors"
                    title="Use in a new chat"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </button>
                  <a
                    href={item.url}
                    download={item.name}
                    onClick={(e) => e.stopPropagation()}
                    className="p-1.5 rounded-lg text-white bg-black/40 hover:bg-black/60 transition-colors"
                    title="Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                </div>
                {/* caption */}
                <div className="px-2 py-1.5 border-t border-[var(--ds-hairline-soft)]">
                  <div className="flex items-center gap-1.5">
                    <span className={`min-w-0 flex-1 truncate text-[12px] font-medium ${INK}`} title={item.name}>{item.name}</span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <OriginBadge origin={item.origin} />
                    <span className={`text-[10px] ${MUTED} tabular-nums`}>{formatBytes(item.bytes)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={`overflow-hidden ${RADIUS_PANEL} ${HAIRLINE} bg-[var(--ds-surface-soft)]`}>
            {/* column header */}
            <div className={`hidden sm:flex items-center gap-3 px-3 py-2 border-b border-[var(--ds-hairline)] ${LABEL}`}>
              <span className="w-10 shrink-0" />
              <span className="flex-1">Name</span>
              <span className="w-28 shrink-0">Source</span>
              <span className="w-28 shrink-0">Modified</span>
              <span className="w-16 shrink-0 text-right">Size</span>
              <span className="w-24 shrink-0" />
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                className={`group flex items-center gap-3 px-3 py-2 border-b border-[var(--ds-hairline-soft)] last:border-0 hover:bg-[var(--ds-hover)] ${TRANSITION} cursor-pointer`}
                onClick={() => open(item)}
              >
                <Thumb item={item} size="row" />
                <div className="min-w-0 flex-1">
                  <span className={`block truncate text-[13px] font-medium ${INK}`} title={item.name}>{item.name}</span>
                  <span className="sm:hidden flex items-center gap-2 mt-0.5">
                    <OriginBadge origin={item.origin} />
                    <span className={`text-[10px] ${MUTED}`}>{formatModified(item.createdAt)} · {formatBytes(item.bytes)}</span>
                  </span>
                </div>
                <span className="hidden sm:block w-28 shrink-0"><OriginBadge origin={item.origin} /></span>
                <span className={`hidden sm:block w-28 shrink-0 text-[12px] ${MUTED}`}>{formatModified(item.createdAt)}</span>
                <span className={`hidden sm:block w-16 shrink-0 text-right text-[12px] ${MUTED} tabular-nums`}>{formatBytes(item.bytes)}</span>
                <div className="w-24 shrink-0 hidden sm:flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); onUseInChat(item); }}
                    className={`p-1.5 rounded-lg ${MUTED} hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION}`}
                    title="Use in a new chat"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onOpenSource(item.sessionId); }}
                    className={`p-1.5 rounded-lg ${MUTED} hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION}`}
                    title="Open source chat"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                  <a
                    href={item.url}
                    download={item.name}
                    onClick={(e) => e.stopPropagation()}
                    className={`p-1.5 rounded-lg ${MUTED} hover:text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION}`}
                    title="Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <Lightbox
          item={preview}
          onClose={() => setPreview(null)}
          onOpenSource={(id) => { setPreview(null); onOpenSource(id); }}
          onUseInChat={(item) => { setPreview(null); onUseInChat(item); }}
        />
      )}
    </div>
  );
};

export default LibraryView;

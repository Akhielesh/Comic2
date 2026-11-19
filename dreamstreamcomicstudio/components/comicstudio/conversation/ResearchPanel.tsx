import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, ImageOff, ImagePlus, Images, Search } from 'lucide-react';
import { isAttachable, normalizeComicResearch, type ComicResearchResult, type ComicResearchResults } from '../../../shared/comic/research';
import { languageSpec } from '../../../shared/comic/languages';
import { post } from '../../../services/apiClient';
import { DENSITY, FIELD, MUTED, RADIUS_CONTROL } from '../../chat/studioDesign';
import { Button } from '../../ds/Button';
import { cn } from '../../../lib/utils';

interface Props {
  projectId: string;
  onAdd: (result: ComicResearchResult, file?: File) => void;
  /** Director results use this same selector without starting a second search. */
  suppliedResults?: ComicResearchResults;
  /**
   * Commons pictures are not checked against a comic's rating, so they wait behind one "Show pictures" tap unless the
   * comic is rated PG-13 (the caller passes false then). Defaults to true: a caller that does not know the rating hides them.
   */
  kidsSafe?: boolean;
  /** Whether a source URL is pinned to this comic (shared/comic/research.ts pinnedSourceUrls). */
  isPinned?: (url: string) => boolean;
}

const IMAGE_LIMIT = 2 * 1024 * 1024;
const LINK = cn('inline-flex min-w-0 items-center gap-1 text-[var(--ds-accent)] underline underline-offset-2', DENSITY.coarse);
const NOTE = cn('text-[12px]', MUTED);
const PINNED = 'Pinned to this comic';

type PanelState = 'idle' | 'searching' | 'adding' | 'search-error' | 'image-error';

/** The one status line the panel shows at a time (text budget: never two). */
const statusLine = (state: PanelState, results?: ComicResearchResults): { text: string; alert: boolean } | null => {
  if (state === 'searching') return { text: 'Searching Wikipedia and Wikimedia Commons…', alert: false };
  if (state === 'adding') return { text: 'Preparing the selected image…', alert: false };
  if (state === 'search-error') return { text: 'Research is temporarily unavailable. Try again in a moment.', alert: true };
  if (state === 'image-error') return { text: 'This image couldn’t be attached. You can still open its source.', alert: true };
  if (!results) return null;
  if (!results.articles.length && !results.images.length) {
    return { text: results.incomplete ? 'No matches, and one source is unavailable. Try again in a moment.' : 'No matches. Try a more specific place or date.', alert: false };
  }
  return results.incomplete ? { text: 'One source is unavailable. Showing the results we found.', alert: false } : null;
};

export function ResearchPanel({ projectId, onAdd, suppliedResults, kidsSafe = true, isPinned }: Props) {
  const [query, setQuery] = useState('');
  const [foundResults, setResults] = useState<ComicResearchResults>();
  const results = useMemo(() => normalizeComicResearch(suppliedResults ?? foundResults), [suppliedResults, foundResults]);
  const [state, setState] = useState<PanelState>('idle');
  // "Show pictures" holds for this set of pictures only: other pictures, or a new search, ask again.
  const pictures = results ? results.images.map((image) => image.source).join('\n') : '';
  const [shownFor, setShownFor] = useState('');
  const showPictures = !kidsSafe || (!!pictures && shownFor === pictures);
  const queryId = useId();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const busy = state === 'searching' || state === 'adding';
  const pinned = (url: string) => !!isPinned?.(url);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2 || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setState('searching');
    setResults(undefined);
    setShownFor('');
    try {
      const found = await post<{ query: string }, ComicResearchResults>(`/api/comic/projects/${encodeURIComponent(projectId)}/research`, { query: query.trim() }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResults(found);
      setState('idle');
    } catch {
      if (!controller.signal.aborted) setState('search-error');
    }
  };

  const addImage = async (result: ComicResearchResult) => {
    if (!result.thumbnail || busy || !isAttachable(result)) return;
    const controller = new AbortController();
    request.current = controller;
    setState('adding');
    const timeout = setTimeout(() => controller.abort('timeout'), 8_000);
    try {
      const response = await fetch(result.thumbnail, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(mime) || !response.body) throw new Error('Image unavailable.');
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > IMAGE_LIMIT) {
          void reader.cancel();
          throw new Error('Image too large.');
        }
        chunks.push(part.value.slice().buffer);
      }
      if (controller.signal.aborted) return;
      if (!size) throw new Error('Image was empty.');
      const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
      onAdd(result, new File(chunks, `${result.title.slice(0, 64)}.${extension}`, { type: mime }));
      setState('idle');
    } catch {
      if (!controller.signal.aborted || controller.signal.reason === 'timeout') setState('image-error');
    } finally {
      clearTimeout(timeout);
    }
  };

  const status = statusLine(state, results);

  return (
    <div className="min-w-0 space-y-3 p-2 text-[13px]">
      {!suppliedResults && <form onSubmit={(event) => void search(event)} className="flex min-w-0 gap-2">
        <label className="sr-only" htmlFor={queryId}>Place, event, or topic</label>
        <input id={queryId} value={query} onChange={(event) => setQuery(event.target.value)} className={cn(FIELD, DENSITY.coarse, 'min-w-0 flex-1 px-2')} maxLength={120} placeholder="Place, event, or topic" />
        <Button type="submit" size="sm" variant="outline" disabled={busy || query.trim().length < 2}><Search aria-hidden className="size-3.5" /> Search</Button>
      </form>}
      {status && <p role={status.alert ? 'alert' : 'status'} className={cn(!status.alert && results && !busy && MUTED)}>{status.text}</p>}
      {results && (results.articles.length > 0 || results.images.length > 0) && (
        <div className="grid max-h-[min(22rem,48dvh)] min-w-0 gap-3 overflow-y-auto overscroll-contain">
          {results.articles.length > 0 && (
            <ul className="m-0 grid min-w-0 list-none gap-2 p-0" aria-label="Articles">
              {results.articles.map((result) => (
                <ArticleItem key={result.source} result={result} busy={busy} pinned={pinned(result.source)} onAdd={() => onAdd(result)} />
              ))}
            </ul>
          )}
          {results.images.length > 0 && !showPictures && (
            <div>
              <Button size="sm" variant="outline" onClick={() => setShownFor(pictures)}><Images aria-hidden className="size-3.5" /> Show pictures</Button>
            </div>
          )}
          {results.images.length > 0 && showPictures && (
            <ul className="m-0 grid min-w-0 list-none grid-cols-[repeat(auto-fill,minmax(min(100%,8rem),1fr))] gap-2 p-0" aria-label="Image references">
              {results.images.map((result) => (
                <PictureTile key={result.source} result={result} busy={busy} pinned={pinned(result.source)} onAdd={() => void addImage(result)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Title, at most two lines of extract (or description) with More, and one row of actions. */
function ArticleItem({ result, busy, pinned, onAdd }: { result: ComicResearchResult; busy: boolean; pinned: boolean; onAdd: () => void }) {
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const summary = result.extract || result.description;
  const language = result.lang && result.lang !== 'en' ? languageSpec(result.lang) : undefined;
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [summary, open]);
  return (
    <li className="min-w-0 border-b border-[var(--ds-hairline)] pb-2 [overflow-wrap:anywhere]">
      <p className="font-semibold" lang={language?.code} dir="auto">{result.title}</p>
      {summary && (
        <p id={textId} ref={textRef} data-research-clamp="" lang={language?.code} dir="auto" className={cn(MUTED, !open && 'line-clamp-2')}>
          {summary}
        </p>
      )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <a href={result.source} target="_blank" rel="noreferrer" className={LINK}>
          Wikipedia{language && <> · <span lang={language.code}>{language.endonym}</span></>}
          <ExternalLink aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">: {result.title}</span>
        </a>
        {summary && overflows && (
          <Button size="sm" variant="link" className="px-0 has-[>svg]:px-0" aria-expanded={open} aria-controls={textId} onClick={() => setOpen((o) => !o)}>
            {open ? 'Less' : 'More'}
          </Button>
        )}
        <span className="ms-auto">
          {pinned ? <span className={NOTE}>{PINNED}</span> : <Button size="sm" variant="ghost" disabled={busy} onClick={onAdd}>Add context</Button>}
        </span>
      </div>
    </li>
  );
}

/** One picture: the image, a one-line title, a one-line credit, and what may be done with it. */
function PictureTile({ result, busy, pinned, onAdd }: { result: ComicResearchResult; busy: boolean; pinned: boolean; onAdd: () => void }) {
  const titleId = useId();
  // A picture Commons cannot serve (offline, blocked, removed) keeps its place as an empty well, never a broken image.
  const [failed, setFailed] = useState(false);
  const credit = [result.credit, result.license].filter(Boolean).join(' · ');
  const frame = cn('aspect-[3/2] w-full bg-[var(--ds-well)]', RADIUS_CONTROL);
  return (
    <li aria-labelledby={titleId} className={cn('min-w-0 border border-[var(--ds-hairline)] p-1', RADIUS_CONTROL)}>
      {failed ? (
        <div data-testid="research-picture-unavailable" aria-hidden className={cn(frame, 'flex items-center justify-center', MUTED)}>
          <ImageOff className="size-4" />
        </div>
      ) : (
        <img alt="" src={result.thumbnail} crossOrigin="anonymous" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cn(frame, 'object-cover')} />
      )}
      <p id={titleId} title={result.title} dir="auto" className="mt-1 truncate text-[12px] font-semibold">{result.title}</p>
      {credit && <p title={credit} dir="auto" className={cn('truncate', NOTE)}>{credit}</p>}
      <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <a href={result.source} target="_blank" rel="noreferrer" className={LINK}>
          Open source <ExternalLink aria-hidden className="size-3 shrink-0" />
          <span className="sr-only"> for {result.title}</span>
        </a>
        {pinned ? (
          <span className={NOTE}>{PINNED}</span>
        ) : isAttachable(result) ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onAdd}><ImagePlus aria-hidden className="size-3.5" /> Add image</Button>
        ) : (
          <span className={NOTE} title="Only public-domain and CC0 pictures can be attached for drawing">Reference only</span>
        )}
      </div>
    </li>
  );
}

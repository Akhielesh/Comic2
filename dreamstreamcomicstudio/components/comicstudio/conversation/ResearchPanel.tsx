import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ExternalLink, ImagePlus, Search } from 'lucide-react';
import { normalizeComicResearch, type ComicResearchResult, type ComicResearchResults } from '../../../shared/comic/research';
import { post } from '../../../services/apiClient';
import { DENSITY, FIELD } from '../../chat/studioDesign';
import { Button } from '../../ds/Button';
import { cn } from '../../../lib/utils';

interface Props {
  projectId: string;
  onAdd: (result: ComicResearchResult, file?: File) => void;
  /** Director results use this same selector without starting a second search. */
  suppliedResults?: ComicResearchResults;
}

const IMAGE_LIMIT = 2 * 1024 * 1024;

export function ResearchPanel({ projectId, onAdd, suppliedResults }: Props) {
  const [query, setQuery] = useState('');
  const [foundResults, setResults] = useState<ComicResearchResults>();
  const results = useMemo(() => normalizeComicResearch(suppliedResults ?? foundResults), [suppliedResults, foundResults]);
  const [state, setState] = useState<'idle' | 'searching' | 'adding' | 'search-error' | 'image-error'>('idle');
  const queryId = useId();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const busy = state === 'searching' || state === 'adding';

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2 || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setState('searching');
    setResults(undefined);
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
    if (!result.thumbnail || busy) return;
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

  const sourceLink = (result: ComicResearchResult) => (
    <a href={result.source} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-[var(--ds-accent)] underline underline-offset-2">
      Source <ExternalLink aria-hidden className="size-3" />
      <span className="sr-only"> for {result.title}</span>
    </a>
  );

  return (
    <div className="min-w-0 space-y-3 p-2 text-[13px]">
      {!suppliedResults && <form onSubmit={(event) => void search(event)} className="flex min-w-0 gap-2">
        <label className="sr-only" htmlFor={queryId}>Place, event, or topic</label>
        <input id={queryId} value={query} onChange={(event) => setQuery(event.target.value)} className={cn(FIELD, DENSITY.coarse, 'min-w-0 flex-1 px-2')} maxLength={120} placeholder="Place, event, or topic" />
        <Button type="submit" size="sm" variant="outline" disabled={busy || query.trim().length < 2}><Search aria-hidden className="size-3.5" /> Search</Button>
      </form>}
      {state === 'searching' && <p role="status">Searching Wikipedia and Wikimedia Commons…</p>}
      {state === 'adding' && <p role="status">Preparing the selected image…</p>}
      {state === 'search-error' && <p role="alert">Research is temporarily unavailable. Try again in a moment.</p>}
      {state === 'image-error' && <p role="alert">This image couldn’t be attached. You can still open its source.</p>}
      {results && (
        <div className="grid max-h-[min(22rem,48dvh)] gap-3 overflow-y-auto overscroll-contain">
          {results.incomplete && <p className="text-[var(--ds-muted)]">One source is unavailable. Showing the results we found.</p>}
          {!results.articles.length && !results.images.length && <p>No matches. Try a more specific place or date.</p>}
          {results.articles.map((result) => (
            <div key={result.source} className="min-w-0 border-b border-[var(--ds-hairline)] pb-2 [overflow-wrap:anywhere]">
              <p className="font-semibold">{result.title}</p>
              {result.description && <p className="text-[var(--ds-muted)]">{result.description}</p>}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
                {sourceLink(result)}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAdd(result)}>Add context</Button>
              </div>
            </div>
          ))}
          {results.images.length > 0 && (
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2" aria-label="Image references">
              {results.images.map((result) => (
                <li key={result.source} className="min-w-0 rounded-md border border-[var(--ds-hairline)] p-1 [overflow-wrap:anywhere]">
                  <img alt="" src={result.thumbnail} crossOrigin="anonymous" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="aspect-[3/2] w-full rounded-sm object-cover" />
                  <p className="mt-1 text-[12px] font-semibold">{result.title}</p>
                  <p className="text-[11px] text-[var(--ds-muted)]">{[result.credit, result.license].filter(Boolean).join(' · ')}</p>
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    {sourceLink(result)}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void addImage(result)}><ImagePlus aria-hidden className="size-3.5" /> Add image</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

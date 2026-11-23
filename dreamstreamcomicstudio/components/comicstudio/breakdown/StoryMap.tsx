import React, { useMemo, useRef, useState } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { sceneIndex } from '../../../shared/comic/continuity';
import { FOCUS_RING, WRAP_TEXT } from '../../chat/studioDesign';

const searchable = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/** Index the author's own script, artwork directions and dialogue. Opening a page uses the existing plan selection. */
export function StoryMap({ doc, onPage }: { doc: ComicDoc; onPage: (id: string) => void }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const pages = useMemo(() => {
    if (!open) return [];
    const scenes = sceneIndex(doc, { derive: true });
    const cast = new Map(doc.cast.map(c => [c.id, c.name]));
    let chapter = '';
    return [...doc.pages].sort((a,b) => a.n - b.n).map(page => {
      if (page.chapterTitle?.trim()) chapter = page.chapterTitle.trim();
      const scene = scenes.scenes.find(s => s.id === scenes.byPage[page.id]);
      const place = scene?.placeId ? doc.places.find(p => p.id === scene.placeId)?.name || scene.name : scene?.name;
      const label = [chapter, place].filter(Boolean).join(' · ');
      const names = [...new Set(page.panels.flatMap(p => p.castIds).map(id => cast.get(id)).filter(Boolean))].join(', ');
      const summary = page.summary || page.panels.find(p => p.action)?.action || page.turnHook;
      const dialogue = page.panels.flatMap(p => [p.action, ...p.lines.map(line => line.text)]).join(' ');
      const changes = page.continuity;
      const visuals = changes ? [
        ...Object.entries(changes.props || {}).flatMap(([name,state]) => [name, state]),
        ...Object.entries(changes.cast || {}).flatMap(([id,state]) => [cast.get(id), state?.outfit, ...(state?.holding || []), ...(state?.marks || [])])
      ].join(' ') : '';
      return { id:page.id, n:page.n, label, summary, text:searchable([page.n, label, names, summary, page.turnHook, dialogue, visuals].join(' ')) };
    });
  }, [doc, open]);
  const words = searchable(query).trim().split(/\s+/).filter(Boolean);
  const visible = pages.filter(page => words.every(word => page.text.includes(word)));
  const choose = (id: string) => {
    if (disclosure.current) disclosure.current.open = false;
    setQuery('');
    onPage(id);
  };
  return (
    <details ref={disclosure} onToggle={e => setOpen(e.currentTarget.open)} className="my-2 min-w-0">
      <summary className={`tap-target cursor-pointer rounded py-2 text-sm font-medium text-[var(--ds-ink)] ${FOCUS_RING}`}>Find a page in this story</summary>
      {open && <div className="min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-2">
        <input type="search" aria-label="Search the page plan" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Character, scene, prop or dialogue" className={`min-h-11 w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 text-base text-[var(--ds-ink)] ${FOCUS_RING}`} />
        <p role="status" className="px-2 py-1 text-xs text-[var(--ds-muted)]">{visible.length ? `${visible.length} ${visible.length === 1 ? 'page' : 'pages'}` : 'No matching pages. Try a name or a shorter phrase.'}</p>
        <ol aria-label="Matching story pages" className="max-h-64 overflow-y-auto">
          {visible.map(page => <li key={page.id}>
            <button type="button" onClick={() => choose(page.id)} className={`block min-h-11 w-full rounded-lg p-2 text-start text-sm hover:bg-[var(--ds-hover)] ${FOCUS_RING} ${WRAP_TEXT}`}>
              <span className="font-semibold">Page {page.n}</span>{page.label && <span className="text-[var(--ds-muted)]"> · {page.label}</span>}
              {page.summary && <span className="block">{page.summary}</span>}
            </button>
          </li>)}
        </ol>
      </div>}
    </details>
  );
}

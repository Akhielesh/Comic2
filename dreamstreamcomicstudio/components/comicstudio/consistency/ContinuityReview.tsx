import React, { useId, useMemo, useRef, useState } from 'react';
import { continuityEditVersion, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { resolveContinuity } from '../../../shared/comic/continuity';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { inverseOps } from '../../../shared/comic/undo';
import { canServeToOwner } from '../../../shared/comic/safety';
import { FIELD, WRAP_TEXT } from '../../chat/studioDesign';
import { GhostButton, PrimaryButton } from '../board/ui';
import { TimelineDialog } from '../timeline/ui';
import type { StudioController } from '../types';
import { CORRECTION_FIELDS, correctionOp, detailAt, pageRanges, pagesUsing, type CorrectionField, type Subject } from '../../../shared/comic/pageCorrection';
import { currentDrawingCheck, savedReviewNotes, type ReviewNote } from '../../../shared/comic/reviewNotes';

const control = `${FIELD} block min-h-11 w-full min-w-0 px-3 py-2 text-sm`;
const label = 'grid min-w-0 gap-1 text-sm font-medium';
const hint = `text-xs leading-relaxed text-[var(--ds-muted)] ${WRAP_TEXT}`;

/** Opens from the page being reviewed. Editing this comic's ledger performs one free, undoable project patch. */
export function ContinuityReview({ studio, doc, page, onClose }: { studio: StudioController; doc: ComicDoc; page: Page; onClose: () => void }) {
  const id = useId();
  const visible = useMemo(() => new Set(page.panels.flatMap(panel => panel.castIds)), [page.panels]);
  const cast = doc.cast.filter(person => visible.has(person.id));
  const [subjectId, setSubjectId] = useState(cast[0]?.id ?? '');
  const [field, setField] = useState<CorrectionField>('outfit');
  const [propName, setPropName] = useState('');
  const subject = useMemo<Subject>(() => subjectId ? { kind: 'cast', id: subjectId, field } : { kind: 'prop', name: propName.trim() }, [subjectId, field, propName]);
  const selected = useMemo(() => detailAt(doc, page, subject), [doc, page, subject]);
  const resolved = useMemo(() => resolveContinuity(doc, page), [doc, page]);
  const origin = doc.pages.find(p => p.n === selected.since);
  const applies = useMemo(() => origin ? pageRanges(pagesUsing(doc, origin, subject)) : '', [doc, origin, subject]);
  const [edit, setEdit] = useState<{ value: string; version: string } | null>(null);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<Extract<DocOp, { op: 'continuity' }> | null>(null);
  const displayed = edit?.value ?? selected.text;
  const changedOutside = !!edit && edit.version !== continuityEditVersion(page) && !pending;
  const candidate = correctionOp(page, subject, displayed);
  const asset = page.render.asset && canServeToOwner(page.render.asset) ? page.render.asset : undefined;
  const thumbnail = asset && studio.urlFor(asset, { width: 480 });
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [inspect, setInspect] = useState(false);
  const original = asset && (inspect || !thumbnail || failedImages.includes(thumbnail)) ? studio.urlFor(asset) : undefined;
  const image = original && !failedImages.includes(original) ? original : thumbnail;
  const showImage = image && !failedImages.includes(image);
  const sourcePages = doc.pages.filter(p => page.render.anchorKeys?.includes(`prev:${p.id}`)).sort((a, b) => a.n - b.n);
  const checks = savedReviewNotes(doc, page);
  const check = currentDrawingCheck(page);
  const active = checks.filter(note => !note.dismissed);
  const dismissed = checks.filter(note => note.dismissed);
  async function setDismissed(note: ReviewNote, value: boolean) {
    if (!check || saving.current) return;
    const op: DocOp = { op: 'finding', pageId: page.id, id: note.id, check, ...(note.issueIndex !== undefined ? { issueIndex: note.issueIndex } : {}), patch: { dismissed: value } };
    saving.current = true;
    setPending(true);
    setNotice('');
    let failed = false;
    try {
      await studio.patch([op], { label: `${value ? 'dismiss' : 'restore'} page ${page.n} finding`, onFailed: () => { failed = true; } });
    } catch { failed = true; }
    finally {
      setNotice(failed ? 'The change could not be confirmed. Review the current drawing before trying again.' :
        value ? 'Finding dismissed for this drawing.' : 'Finding restored for this drawing.');
      saving.current = false;
      setPending(false);
    }
  }
  function noteRow(note: ReviewNote) {
    const noteId = `${id}-note-${note.issueIndex === undefined ? 'finding' : 'issue'}-${note.id}`;
    return <li key={noteId} className="space-y-1"><span id={noteId}>{note.text}</span>
      {check && !note.readOnly && <GhostButton size="sm" aria-describedby={noteId} disabled={pending} onClick={() => void setDismissed(note, !note.dismissed)}>
        {note.dismissed ? 'Restore finding' : 'Dismiss finding'}
      </GhostButton>}</li>;
  }

  function reset() { setEdit(null); setNotice(''); }
  async function save(action: 'edit' | 'remove' | 'undo') {
    if (saving.current || changedOutside) return;
    const op = action === 'undo' ? undo : (action === 'remove' ? correctionOp(page, subject, null) : candidate).op;
    if (!op || (action === 'edit' && displayed.trim() === selected.text)) return;
    const inverse = inverseOps(doc, [op]).find(edit => edit.op === 'continuity');
    const predicted = applyOp(doc, op).pages.find(p => p.id === page.id);
    saving.current = true;
    setPending(true);
    setNotice('');
    let failed = false;
    try {
      await studio.patch([op], { label: `continuity on page ${page.n}`, onFailed: () => { failed = true; } });
      if (!failed) {
        setEdit(null);
        setUndo(action !== 'undo' && inverse && predicted ? { ...inverse, ifUnchanged: continuityEditVersion(predicted) } : null);
        setNotice(action === 'undo' ? 'Previous details restored.' : action === 'remove' ? 'Page correction removed.' : 'Correction saved to this comic.');
      }
    } catch { failed = true; }
    finally {
      if (failed) setNotice('The save could not be confirmed. Check this page’s current details before trying again.');
      saving.current = false;
      setPending(false);
    }
  }
  const person = cast.find(c => c.id === subjectId);
  const castGuide = person?.look[field === 'holding' ? 'props' : field] || (field === 'marks' && person?.look.markings) || person?.look.summary;
  const native = subject.kind === 'prop' ? page.continuity?.props?.[subject.name] : page.continuity?.cast?.[subject.id]?.[subject.field];
  return <TimelineDialog open onClose={onClose} title={`Continuity · Page ${page.n}`}>
    <div className="grid min-w-0 gap-4">
      {(asset || page.summary) && <div className={inspect ? 'grid min-w-0 gap-2' : 'flex min-w-0 items-start gap-3'}>
        {showImage && <img src={image} alt={`Current drawing of page ${page.n}`} onError={() => setFailedImages(urls => [...urls, image])} className={inspect ? 'mx-auto max-h-[70dvh] max-w-full overflow-hidden rounded-md object-contain' : 'h-24 w-20 shrink-0 rounded-md object-contain'} />}
        <div className="min-w-0 space-y-1"><p className="text-xs font-semibold">Page {page.n} of {doc.pages.length}</p>
          {page.summary && <p className={hint}>{page.summary}</p>}
          {asset && sourcePages.length > 0 && <p className={hint}>This drawing used artwork from {sourcePages.length === 1 ? 'page' : 'pages'} {pageRanges(sourcePages.map(p => p.n))} as a visual reference.</p>}
          {showImage && <GhostButton size="xs" aria-expanded={inspect} onClick={() => setInspect(value => !value)}>{inspect ? 'Reduce artwork' : 'Inspect artwork'}</GhostButton>}
          {asset && image && !showImage && <p className={hint}>Artwork preview unavailable.</p>}</div>
      </div>}
      {!!checks.length && <section aria-labelledby={`${id}-checks`}>
        <h3 id={`${id}-checks`} className="text-sm font-semibold">Review notes on this drawing</h3>
        {!!active.length && <ul aria-labelledby={`${id}-checks`} className={`list-disc space-y-2 pl-4 ${hint}`}>{active.map(noteRow)}</ul>}
        {!!dismissed.length && <details className={hint}><summary className="cursor-pointer py-2">Dismissed findings ({dismissed.length})</summary>
          <ul aria-label="Dismissed findings" className="list-disc space-y-2 pl-4">{dismissed.map(noteRow)}</ul></details>}
      </section>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={label}>Subject<select className={control} value={subjectId} disabled={pending} onChange={e => { setSubjectId(e.target.value); reset(); }}>
          {cast.map(c => <option key={c.id} value={c.id}>{c.name || 'Unnamed character'}</option>)}<option value="">Prop</option></select></label>
        {subjectId ? <label className={label}>Detail<select className={control} value={field} disabled={pending} onChange={e => { setField(e.target.value as CorrectionField); reset(); }}>
          {Object.entries(CORRECTION_FIELDS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          : <label className={label}>Prop name<input className={control} list={`${id}-props`} value={propName} disabled={pending} onChange={e => { setPropName(e.target.value); reset(); }} />
            <datalist id={`${id}-props`}>{Object.keys(resolved?.props ?? {}).map(name => <option key={name} value={name} />)}</datalist></label>}
      </div>
      <div className="min-w-0 space-y-1 border-l-2 border-[var(--ds-hairline)] pl-3" aria-label="Current drawing instructions">
        {selected.text ? <><p className={`text-sm font-medium whitespace-pre-line ${WRAP_TEXT}`}>{selected.text}</p>
          <p className={hint}>From page {selected.since}{applies && ` · Used when drawing ${applies.includes('–') || applies.includes(',') ? 'pages' : 'page'} ${applies}`}</p></>
          : <p className={hint}>{castGuide ? `Cast guide · ${castGuide}` : 'This page has no saved direction for this detail.'}</p>}
      </div>
      <label className={label}>Correct detail<textarea className={control} rows={2} value={displayed} disabled={pending || (!subjectId && !propName.trim())} aria-describedby={`${id}-scope`} placeholder={field === 'holding' && subjectId ? 'What should they be carrying?' : 'Describe what the artist should draw.'} onChange={e => {
        setEdit({ value: e.target.value, version: edit?.version ?? continuityEditVersion(page) }); setNotice('');
      }} /></label>
      <p id={`${id}-scope`} className={hint}>{subjectId && field === 'holding' ? 'Carries through this scene until changed. Put each item on its own line.' : subjectId && field === 'marks' ? 'Carries forward when this character appears, until changed. Put each mark on its own line.' : subjectId ? 'Carries forward when this character appears, until changed.' : 'Carries forward from this page until the prop’s state changes.'} Saving is free. Existing artwork changes only when you choose a priced redraw.</p>
      {candidate.error && <p role="alert" className={hint}>{candidate.error}</p>}
      {changedOutside && <div><p className={hint}>This page changed while you were editing.</p><GhostButton size="sm" onClick={reset}>Review latest details</GhostButton></div>}
      <div className="flex flex-wrap items-center gap-2"><PrimaryButton size="sm" busy={pending} disabled={!candidate.op || !edit || displayed.trim() === selected.text || changedOutside} onClick={() => void save('edit')}>Save correction</PrimaryButton>
        {native !== undefined && native !== null && <GhostButton size="sm" disabled={pending || changedOutside} onClick={() => void save('remove')}>Remove page correction</GhostButton>}
      </div>
      <p role="status" className={hint}>{notice}</p>
      {undo?.ifUnchanged === continuityEditVersion(page) && <GhostButton size="sm" className="justify-self-start" disabled={pending || changedOutside} onClick={() => void save('undo')}>Undo last correction</GhostButton>}
    </div>
  </TimelineDialog>;
}

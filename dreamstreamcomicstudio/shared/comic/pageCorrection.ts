import { continuityEditVersion, type ComicDoc, type Page } from './doc.js';
import { resolveContinuity } from './continuity.js';
import { CONSISTENCY_LIMITS, PRO_PAGE_LIMITS } from './limits.js';
import type { ContinuityPatch, DocOp } from './ops.js';

export const CORRECTION_FIELDS = { outfit: 'Outfit', marks: 'Distinguishing marks', holding: 'Item carried' } as const;
export type CorrectionField = keyof typeof CORRECTION_FIELDS;
export type Subject = { kind: 'cast'; id: string; field: CorrectionField } | { kind: 'prop'; name: string };

export function detailAt(doc: ComicDoc, page: Page, subject: Subject) {
  const state = resolveContinuity(doc, page);
  if (subject.kind === 'prop') {
    const prop = state?.props[subject.name];
    return { text: prop?.state ?? '', since: prop?.since };
  }
  const cast = state?.cast[subject.id];
  const value = cast?.[subject.field];
  return { text: Array.isArray(value) ? value.join('\n') : value ?? '', since: cast?.since[subject.field] };
}

export function pagesUsing(doc: ComicDoc, start: Page, subject: Subject): number[] {
  return doc.pages.filter(page => page.n >= start.n && (subject.kind === 'prop' || page.panels.some(panel => panel.castIds.includes(subject.id)))
    && detailAt(doc, page, subject).since === start.n).map(page => page.n).sort((a, b) => a - b);
}

export function pageRanges(numbers: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    const start = numbers[i];
    while (i + 1 < numbers.length && numbers[i + 1] === numbers[i] + 1) i++;
    ranges.push(start === numbers[i] ? String(start) : `${start}–${numbers[i]}`);
  }
  return ranges.join(', ');
}

export function correctionOp(page: Page, subject: Subject, input: string | null): { op?: Extract<DocOp, { op: 'continuity' }>; error?: string } {
  const patch: ContinuityPatch = { by: 'user' };
  const lines = input?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [];
  const list = subject.kind === 'cast' && subject.field !== 'outfit';
  if (input !== null && !lines.length) return {};
  if (input !== null && (list ? lines.length > PRO_PAGE_LIMITS.continuityListItems || lines.some(s => s.length > PRO_PAGE_LIMITS.continuityTextChars) : lines.join(' ').length > PRO_PAGE_LIMITS.continuityTextChars)) {
    return { error: list ? `Use up to ${PRO_PAGE_LIMITS.continuityListItems} lines of ${PRO_PAGE_LIMITS.continuityTextChars} characters each.` : `Use up to ${PRO_PAGE_LIMITS.continuityTextChars} characters.` };
  }
  if (subject.kind === 'prop') {
    const name = subject.name.trim();
    if (!name) return {};
    if (['__proto__', 'prototype', 'constructor'].includes(name) || name.length > PRO_PAGE_LIMITS.sceneNameChars) return { error: 'Use a short, distinct prop name.' };
    const props = { ...page.continuity?.props };
    if (input === null) delete props[name];
    else props[name] = lines.join(' ');
    if (Object.keys(props).length > CONSISTENCY_LIMITS.propChanges) return { error: `This page already has ${CONSISTENCY_LIMITS.propChanges} prop changes.` };
    patch.props = Object.keys(props).length ? props : null;
  } else {
    const cast = { ...page.continuity?.cast };
    const previous = cast[subject.id];
    // A writer's null restores every field to the cast guide. Keep the other resets when editing one field.
    const change = previous === null ? { outfit:null, marks:null, holding:null, where:null } : { ...previous };
    if (input === null) delete change[subject.field];
    else if (subject.field === 'outfit') change.outfit = lines.join(' ');
    else change[subject.field] = lines;
    if (Object.keys(change).length) cast[subject.id] = change;
    else delete cast[subject.id];
    if (Object.keys(cast).length > CONSISTENCY_LIMITS.castChanges) return { error: `This page already has ${CONSISTENCY_LIMITS.castChanges} cast changes.` };
    patch.cast = Object.keys(cast).length ? cast : null;
  }
  const next = { ...page.continuity, ...patch };
  const empty = !next.cast && !next.props && !next.notes?.length && !next.sceneId;
  return { op: { op: 'continuity', pageId: page.id, patch: empty ? null : patch, ifUnchanged: continuityEditVersion(page) } };
}

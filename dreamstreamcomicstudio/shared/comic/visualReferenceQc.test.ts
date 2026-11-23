import { describe, expect, it } from 'vitest';
import type { ConsistencyFinding, QcReport } from './doc.js';
import { visualReferenceQcAllows } from './visualReferenceQc.js';

const qc = (issues: string[], findings?: ConsistencyFinding[]): QcReport => ({ score: 0.91, checkedAt: 1, issues, findings });

describe('using a checked illustration as a visual reference', () => {
  it.each([
    'The designs do not match the planned shapes: the bodies are drawn as birds instead of whales.',
    'The cast is unrecognizable compared with the reference sheet.',
    'No visual drift in the scenery, but the main figure is off-model.',
    'Wrong visual style, no issues with the caption.',
    'The palette is inconsistent with the sample.',
    'The expected face markings are missing.'
  ])('disqualifies a confirmed visual defect despite a high score: %s', issue => {
    expect(visualReferenceQcAllows(qc([issue]))).toBe(false);
    expect(visualReferenceQcAllows(qc([issue]), true)).toBe(false);
  });

  it.each([
    'No mismatch in the character design.',
    'The style does not drift.',
    'The cast looks consistent throughout.',
    'The cast is shown in the requested silhouette style rather than photorealism.',
    'The caption uses the wrong font style.',
    'One character’s name is misspelled in the caption.',
    'The balloon tail covers part of the panel border.',
    'Panel 2: line missing from the art — “The palette is wrong!”',
    'Stray text drawn in the art: “missing character” — overlay pages should be text-free.',
    'No style issues; the smallest text is difficult to read.'
  ])('keeps a good drawing eligible: %s', issue => {
    expect(visualReferenceQcAllows(qc([issue]), true)).toBe(true);
  });

  it('uses open structured findings, explicit dismissal and missing speakers independently', () => {
    const style: ConsistencyFinding = { id: '1', panel: 2, kind: 'style', severity: 'minor', note: 'Wrong drawing medium.' };
    expect(visualReferenceQcAllows(qc([], [style]))).toBe(false);
    expect(visualReferenceQcAllows(qc([], [{ ...style, note: 'Does not match the approved sheet.' }]))).toBe(false);
    expect(visualReferenceQcAllows(qc([], [{ ...style, dismissed: true }]))).toBe(true);
    expect(visualReferenceQcAllows(qc([], [{ ...style, note: 'The caption font style is wrong.' }]), true)).toBe(true);
    expect(visualReferenceQcAllows({ ...qc([]), missingSpeakers: [{ panel: 1, castId: 'pilot' }] })).toBe(false);
  });

  it('permits unchecked legacy neighbours while requiring evidence to promote older images', () => {
    expect(visualReferenceQcAllows(undefined)).toBe(true);
    expect(visualReferenceQcAllows(undefined, true)).toBe(false);
    expect(visualReferenceQcAllows(qc(['Panel review incomplete']), true)).toBe(false);
  });
});

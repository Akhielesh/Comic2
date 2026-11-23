// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { emptyRender, pageSpecHash, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { getImageModel } from '../../../../shared/comic/models.js';
import { partsOf } from '../../../../shared/comic/parts.js';
import { withoutAssets } from '../../../../shared/comic/sendable.js';
import { isProjectPageArt } from '../assets.js';
import { planAnchors } from '../../../../shared/comic/anchors.js';
import { nearestReadyBefore } from '../../../../shared/comic/sendable.js';
import { continuityAnchorFor } from '../../../../shared/comic/continuity.js';
import { previousPageFor } from './schedule.js';
import { compileCover, compileEdit, compilePage, planPageReferences } from '../prompts.js';
import { runAction } from '../jobs.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';

const owner = 'user-1';
const project = '11111111-1111-4111-8111-111111111111';
const owns = (path: string) => isProjectPageArt(path, owner, project);
const pathAt = (n: number) => `u/${owner}/p/${project}/img/page-${n}.webp`;

function draw(doc: ComicDoc, n: number) {
  const page = doc.pages.find(p => p.n === n)!;
  page.render = {
    status: 'ready', history: [], specHash: pageSpecHash(doc, page), parts: partsOf(doc, page),
    asset: { path: pathAt(n), at: n, source: 'generated', safety: { assessed: 'G', at: n } },
    qc: { score: 0.93, issues: [], checkedAt: n }
  };
  return page;
}

function book() {
  const doc = plannedDoc(project);
  doc.format.pageCount = 24;
  doc.cast[0].sheet = { status: 'ready', history: [], asset: { path: pathAt(117), at: 1, source: 'generated', safety: { assessed: 'G', at: 1 } } };
  doc.cast.push({ id: 'watch', kind: 'object', name: 'Pocket watch', tier: 'extra', refs: [], sheet: emptyRender(), look: { summary: 'An engraved watch.' } });
  doc.places.push({ id: 'tower', name: 'Clock tower', look: 'A brass spiral stair', refs: [], sheet: emptyRender() });
  doc.scenes = [{ id: 'market', name: 'Market' }, { id: 'towerScene', name: 'Tower' }];
  const sample = doc.pages[0];
  doc.pages = Array.from({ length: 24 }, (_, i): Page => {
    const n = i + 1;
    const isTower = [2, 6, 11, 15, 18, 23, 24].includes(n);
    const atTower = isTower && n !== 23;
    return { ...sample, id: 'p' + n, n, render: emptyRender(), panels: [{ ...sample.panels[0], id: 'panel' + n, lines: [],
      castIds: atTower ? ['c_maya', 'watch'] : ['c_arjun'], placeId: atTower ? 'tower' : 'pl_market',
      action: atTower ? 'Maya examines the pocket watch.' : 'Arjun unpacks spices.' }],
      continuity: { sceneId: atTower ? 'towerScene' : 'market' } };
  });
  doc.pages[1].continuity = { sceneId: 'towerScene', cast: { c_maya: { outfit: 'red coat' } }, props: { 'Pocket watch': 'sealed' } };
  doc.pages[10].continuity = { sceneId: 'towerScene', by: 'user', cast: { c_maya: { outfit: 'navy raincoat' } }, props: { 'Pocket watch': 'case open' } };
  for (const n of [2, 6, 11, 15, 18, 23]) draw(doc, n);
  return doc;
}

function job(doc: ComicDoc) {
  const target = doc.pages.find(p => p.n === 24)!;
  return compilePage(doc, target, { previousPage: doc.pages.find(p => p.n === 23), ownsPageArt: owns });
}

describe('returning to established artwork across a 24-page book', () => {
  it('selects the matching later costume and prop, obeys the new scene, and leaves current actions in charge', () => {
    const doc = book();
    const j = job(doc);
    expect(j.earlierPage).toEqual({ id: 'p18', path: pathAt(18) });
    expect(j.prompt).toContain('EARLIER ART — PAGE 18');
    expect(j.prompt).toContain('navy raincoat');
    expect(j.prompt).toContain('case open');
    expect(j.prompt).toContain('Clock tower');
    expect(j.references.some(ref => ref.path === pathAt(23))).toBe(false);
    expect(j.references.some(ref => ref.path === pathAt(6))).toBe(false);
    expect(j.prompt).not.toContain('Page 23 ended with');
    doc.pages.reverse();
    expect(job(doc).earlierPage).toEqual(j.earlierPage);
  });

  it('falls back from a polished but visually off-model page in automatic neighbour, additional art, cover and style-key lanes', () => {
    const doc = book();
    const target = doc.pages[23];
    const faulty = draw(doc, 23);
    faulty.render.qc = { score: 0.92, checkedAt: 12, issues: ['The figures are painted as glossy stone statues rather than the approved cut-paper silhouettes.'] };
    expect(previousPageFor(doc, target)?.id).toBe('p18');
    expect(nearestReadyBefore(doc, target)?.id).toBe('p18');
    // Explicit previous-page and pinned style-key candidates also go through the common QC check.
    doc.consistency = { styleKeyPageId: faulty.id };
    const plan = planAnchors(doc, target, undefined, null, { previousPage: faulty, kinds: { styleKey: true } });
    expect(plan.attached.some(r => r.path === pathAt(23))).toBe(false);
    expect(compilePage(doc, target, { previousPage: faulty }).references.some(r => r.path === pathAt(23))).toBe(false);
    expect(job(doc).earlierPage?.id).toBe('p18');
    doc.pages[17].render.qc = { ...faulty.render.qc, issues: ['The palette and character design fail to match the supplied reference.'] };
    expect(job(doc).earlierPage?.id).toBe('p15');
    for (const p of doc.pages) delete p.continuity;
    expect(continuityAnchorFor(doc, target).page?.id).toBe('p15');
    doc.pages[1].render.qc = faulty.render.qc;
    expect(compileCover(doc).references.find(r => r.label === 'STORY PAGE')?.path).toBe(pathAt(6));
    doc.pages[5].render.asset!.path = pathAt(6).replace(owner, 'different-owner');
    expect(compileCover(doc, { ownsPageArt: owns }).references.find(r => r.label === 'STORY PAGE')?.path).toBe(pathAt(11));
  });

  it('accepts checked artwork with a small lettering issue or a negated defect on the same visual dimensions', () => {
    const doc = book();
    doc.pages[17].render.qc!.issues = ['No visual style drift. The last caption is misspelled.'];
    expect(job(doc).earlierPage?.id).toBe('p18');
    expect(job(doc).references.some(r => r.path === pathAt(18))).toBe(true);
  });

  it('honors a new author outfit or an explicitly cleared prop even when earlier artwork matches every subject', () => {
    const doc = book();
    const target = doc.pages[23];
    target.continuity = { by: 'user', cast: { c_maya: { outfit: 'silver tunic' } }, notes: ['Her hood is down.'] };
    expect(job(doc).earlierPage).toBeUndefined();
    expect(job(doc).prompt).toContain('silver tunic');
    expect(job(doc).prompt).toContain('Her hood is down');
    target.continuity = { by: 'user', props: { 'Pocket watch': null } };
    expect(job(doc).earlierPage).toBeUndefined();
    expect(job(doc).prompt).toContain('No longer present: Pocket watch');
  });

  it('ignores queued, missing, withheld, superseded and cross-owner or cross-project drawings', () => {
    const doc = book();
    doc.pages[17].render.status = 'rendering'; // a parallel scene has not landed yet
    doc.pages[14].render.asset!.path = pathAt(15).replace(owner, 'another-owner');
    expect(job(doc).earlierPage?.id).toBe('p11');
    doc.pages[14].render.asset!.path = pathAt(15).replace(project, 'other-project');
    expect(job(doc).earlierPage?.id).toBe('p11');
    doc.pages[14].render.asset!.path = pathAt(15).replace('page-15', '%2e%2e');
    expect(job(doc).earlierPage?.id).toBe('p11');
    const noBytes = withoutAssets(doc, new Set([pathAt(11)]));
    expect(job(noBytes).earlierPage).toBeUndefined();
    doc.pages[10].render.asset!.safety = { pending: true, at: 9 };
    expect(job(doc).earlierPage).toBeUndefined();
    doc.pages[10].render.asset!.safety = { assessed: 'G', at: 10 };
    doc.pages[10].panels[0].action = 'Changed since that drawing';
    expect(job(doc).earlierPage).toBeUndefined();
  });

  it('rejects a drawing when the author changed its source-era ledger after it was drawn', () => {
    const doc = book();
    doc.pages[17].continuity = { ...doc.pages[17].continuity, by: 'user', cast: { c_maya: { outfit: 'green parka' } } };
    expect(job(doc).earlierPage).toBeUndefined();
    expect(job(doc).prompt).toContain('green parka');
  });

  it('legacy pages without a ledger can reuse checked art with an unchanged canonical script hash', () => {
    const doc = book();
    for (const p of doc.pages) { delete p.continuity; delete p.render.parts; }
    expect(job(doc).earlierPage?.id).toBe('p18');
  });

  it('respects QC issues, unfollows an unticked page, and excludes an unchecked legacy raster with no provenance', () => {
    const doc = book();
    doc.consistency = { skip: ['prev:p18'] };
    expect(job(doc).earlierPage?.id).toBe('p15');
    doc.pages[14].render.qc!.findings = [{ id: 'f', kind: 'identity', panel: 1, severity: 'major', note: 'Wrong figure' }];
    expect(job(doc).earlierPage?.id).toBe('p11');
    delete doc.pages[10].render.parts; // the old hash alone cannot attest a wardrobe correction
    expect(job(doc).earlierPage).toBeUndefined();
    expect(job(doc).prompt).toContain('navy raincoat');
    doc.consistency = { skip: ['char:c_maya'] };
    expect(job(doc).earlierPage).toBeUndefined();
  });

  it('panel corrections use their current raster, scoped canon, and the author’s latest explicit change', () => {
    const doc = book();
    const target = draw(doc, 24);
    const j = compileEdit(doc, target, { instruction: 'Give Maya a silver raincoat', panelN: 1, hasRegion: false });
    expect(j.references[0].path).toBe(pathAt(24));
    expect(j.prompt).toContain('Give Maya a silver raincoat');
    expect(j.prompt).toContain('navy raincoat');
    expect(j.prompt).toContain('this specific change overrides it');
    expect(j.earlierPage).toBeUndefined();
  });

  it('uses at most one extra object slot and never displaces a canonical sheet', () => {
    const doc = book();
    doc.cast[0].sheet = { ...doc.pages[14].render, asset: { ...doc.pages[14].render.asset!, path: pathAt(117) } };
    const target = doc.pages[23];
    const spec = getImageModel('nano-banana-2')!;
    doc.consistency = { maxRefs: 1 };
    const refs = planPageReferences(doc, target, spec, doc.pages[22], { ownsPageArt: owns });
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe(pathAt(117));
  });

  it('a named POV character who is heard but never drawn does not pull their old art into the panel', () => {
    const doc = book();
    doc.pages[23].panels[0] = { ...doc.pages[23].panels[0], castIds: ['c_maya'], placeId: undefined, shot: 'pov', action: "Through Maya's eyes we see rain on the glass." };
    expect(job(doc).earlierPage).toBeUndefined();
  });

  it('keeps earlier prop backlog outside the prompt and prioritizes visible and currently corrected descriptions', () => {
    const doc = book();
    for (let i = 0; i < 10; i++) {
      const p = doc.pages[i];
      p.continuity = { ...p.continuity, props: { ...p.continuity?.props, ['Unused trinket ' + i]: 'left in the old store' } };
    }
    doc.pages[23].continuity = { ...doc.pages[23].continuity, props: { 'Blue ticket': 'torn' } };
    const result = job(doc);
    expect(result.prompt).not.toContain('Unused trinket');
    expect(result.prompt).toContain('Pocket watch: case open');
    expect(result.prompt).toContain('Blue ticket: torn');
  });

  it('does not attach the current or a future page when rendering the book out of order, or a second copy of a sheet', () => {
    const doc = book();
    const current = draw(doc, 6);
    const earlier = compilePage(doc, current, { ownsPageArt: owns });
    expect(earlier.earlierPage?.id).toBe('p2');
    expect(earlier.references.map(ref => ref.path)).not.toContain(pathAt(11));
    doc.pages[17].render.asset!.path = doc.cast[0].sheet.asset!.path;
    const later = job(doc);
    expect(later.earlierPage?.id).toBe('p15');
    expect(new Set(later.references.map(ref => ref.path)).size).toBe(later.references.length);
  });

  it('recompiles past unavailable image bytes in the normal paid page job and retains provenance on a rerender', async () => {
    const doc = book();
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.missing.add(pathAt(18));
    const action = { type: 'render_pages' as const, pageIds: ['p24'], force: true };
    await runAction(ctx, action, { confirmed: true });
    const page = session.doc.pages.find(p => p.n === 24)!;
    expect(page.render.status).toBe('ready');
    expect(page.render.anchorKeys).toContain('prev:p15');
    const actual = ctx.imagesFake.calls.filter(call => call.prompt.includes('Create one finished comic page'));
    expect(actual).toHaveLength(1);
    expect(actual[0].references.some(ref => ref.label === 'EARLIER ART — PAGE 15')).toBe(true);
    expect(actual[0].prompt).not.toContain('EARLIER ART — PAGE 18');
    ctx.assetsFake.missing.delete(pathAt(18));
    await runAction(ctx, action, { confirmed: true });
    const current = session.doc.pages.find(p => p.n === 24)!;
    expect(current.render.anchorKeys).toContain('prev:p18');
    expect(ctx.imagesFake.calls.filter(call => call.prompt.includes('Create one finished comic page'))).toHaveLength(2);
  });
});

// P1-REFS seams (refs.md §9 server): honest adds ("5 photos are Maya" keeps all 5), inbox take +
// prune, quick-assign notes, carried images, the "Who's in these photos?" fallback and the free
// regex pre-pass.
import { describe, expect, it } from 'vitest';
import { emptyRender, type ComicDoc, type Msg, type RefAsset } from '../../../../shared/comic/doc.js';
import { REF_LIMITS } from '../../../../shared/comic/refs.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import {
  addRefs,
  analyzeAttachmentText,
  applyAttachmentTargets,
  carriedImages,
  cleanFileName,
  cleanNote,
  expiredInboxPaths,
  planRefAdds,
  pruneInboxOps,
  refIntentHint,
  takeInbox,
  unassignedImages,
  whoIsInTheseCard
} from './index.js';

const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/user-1/p/proj-1/ref/r${n}.webp`, source: 'upload', at: n, ...extra });
const MAYA = { kind: 'character', id: 'c_maya' } as const;

const userMsg = (id: string, attachments: RefAsset[] = [], text = ''): Msg => ({ id, role: 'user', text, at: 1, ...(attachments.length ? { attachments } : {}) });
const botMsg = (id: string): Msg => ({ id, role: 'assistant', text: 'ok', at: 1 });

describe('addRefs: honest caps', () => {
  it('"these 5 photos are Maya" keeps all five (no silent slice(-4)), main first', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const out = await addRefs(ctx, MAYA, [1, 2, 3, 4, 5].map((n) => ref(n)), { mainIndex: 2 });
    expect(out).toMatchObject({ added: 5, skipped: 0, message: 'Added 5 photos to MAYA.' });
    ctx.session.commit(out.ops);
    expect(ctx.session.doc.cast[0].refs.map((r) => r.path)).toEqual([3, 1, 2, 4, 5].map((n) => ref(n).path));
  });

  it('adds what fits, says the counts, and never exceeds the owner cap', async () => {
    const doc = plannedDoc();
    doc.cast[0].refs = Array.from({ length: 10 }, (_, i) => ref(100 + i));
    const ctx = testContext(newSession(doc));
    const out = await addRefs(ctx, MAYA, [1, 2, 3, 4].map((n) => ref(n)));
    expect(out).toMatchObject({ added: 2, skipped: 2, message: 'Added 2 of 4 photos to MAYA (limit 12).' });
    ctx.session.commit(out.ops);
    expect(ctx.session.doc.cast[0].refs).toHaveLength(REF_LIMITS.character);
  });

  it('counts the whole comic against the 150 project cap', () => {
    const doc = plannedDoc();
    doc.places[0].refs = Array.from({ length: 8 }, (_, i) => ref(500 + i));
    doc.style.refs = Array.from({ length: 8 }, (_, i) => ref(600 + i));
    doc.refInbox = Array.from({ length: 24 }, (_, i) => ref(700 + i));
    // 40 used → put 109 on fake extra owners via cast entries.
    for (let k = 0; k < 10; k += 1) {
      doc.cast.push({ id: `c_x${k}`, name: `X${k}`, tier: 'support', look: { summary: '' }, refs: Array.from({ length: k < 9 ? 12 : 1 }, (_, i) => ref(1000 + k * 20 + i)), sheet: emptyRender() });
    }
    // 40 + 9×12 + 1 = 149 → one more fits, the second does not.
    const planned = planRefAdds(doc, MAYA, [ref(1), ref(2)]);
    expect(planned.added).toBe(1);
    expect(planned.message).toBe('Added 1 of 2 photos to MAYA (limit 150 per comic).');
    const none = planRefAdds({ ...doc, cast: doc.cast.map((c) => (c.id === 'c_maya' ? { ...c, refs: [ref(9)] } : c)) } as ComicDoc, MAYA, [ref(1)]);
    expect(none.added).toBe(0);
    expect(none.message).toMatch(/already has 150 reference photos/);
  });

  it('skips duplicates by path and by the original-file hash', () => {
    const doc = plannedDoc();
    doc.cast[0].refs = [ref(1, { hash: 'aaaaaaaaaaaaaaaa' })];
    const planned = planRefAdds(doc, MAYA, [ref(1), ref(2, { hash: 'aaaaaaaaaaaaaaaa' }), ref(3)]);
    expect(planned).toMatchObject({ added: 1, duplicates: 2, message: 'Added 1 photo to MAYA (2 already there).' });
    expect(planRefAdds(doc, MAYA, [ref(1)]).message).toBe('That photo is already on MAYA.');
  });

  it('labels and notes are kept clean; a missing owner is honest', () => {
    const doc = plannedDoc();
    const planned = planRefAdds(doc, MAYA, [ref(1)], { labels: { 0: { label: 'front', note: ' her\nfestival   outfit ' } } });
    expect(planned.refs[0]).toMatchObject({ label: 'front', note: 'her festival outfit' });
    expect(planRefAdds(doc, { kind: 'character', id: 'gone' }, [ref(1)]).message).toMatch(/no longer exists/);
  });

  it('cleans notes and file names', () => {
    expect(cleanNote('a'.repeat(300))).toHaveLength(REF_LIMITS.noteChars);
    expect(cleanNote('  \n ')).toBeUndefined();
    expect(cleanFileName('C:\\Users\\me\\IMG 2041 (1).jpg')).toBe('IMG 2041 (1).jpg');
    expect(cleanFileName('<script>alert(1)</script>.png')).toBe('script_.png');
    expect(cleanFileName('a<b>"c".png')).toBe('a_b_c_.png');
    expect(cleanFileName('...')).toBeUndefined();
  });
});

describe('inbox', () => {
  it('takeInbox moves inbox refs into attachments in request order and refuses foreign paths', async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref(1), ref(2)];
    const ctx = testContext(newSession(doc));
    const out = await takeInbox(ctx, [ref(2).path, ref(1).path, ref(2).path]);
    expect(out.attachments.map((a) => a.path)).toEqual([ref(2).path, ref(1).path]);
    expect(out.ops).toHaveLength(2);
    await expect(takeInbox(ctx, ['u/other/p/x/ref/evil.webp'])).rejects.toMatchObject({ status: 400 });
    await expect(takeInbox(ctx, Array.from({ length: 13 }, (_, i) => ref(i).path))).rejects.toMatchObject({ status: 400 });
  });

  it('prunes composer uploads older than 24 h (and only those)', () => {
    const now = 10 * 24 * 3600_000;
    const doc = plannedDoc();
    doc.refInbox = [ref(1, { at: now - REF_LIMITS.inboxTtlMs - 1 }), ref(2, { at: now - 1000 })];
    expect(expiredInboxPaths(doc, now)).toEqual([ref(1).path]);
    const session = newSession(doc);
    session.commit(pruneInboxOps(doc, now));
    expect(session.doc.refInbox?.map((r) => r.path)).toEqual([ref(2).path]);
  });
});

describe('applyAttachmentTargets (composer quick-assign)', () => {
  it('files images, creates a new character once, and writes the assignment line', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const out = await applyAttachmentTargets(ctx, [ref(1), ref(2), ref(3), ref(4)], [
      MAYA,
      MAYA,
      { kind: 'new_character', name: 'Bruno', castKind: 'animal' },
      null
    ]);
    ctx.session.commit(out.ops);
    const doc = ctx.session.doc;
    expect(doc.cast[0].refs.map((r) => r.path)).toEqual([ref(1).path, ref(2).path]);
    const bruno = doc.cast.find((c) => c.name === 'Bruno')!;
    expect(bruno).toMatchObject({ kind: 'animal', tier: 'support' });
    expect(bruno.refs.map((r) => r.path)).toEqual([ref(3).path]);
    expect(out.note).toMatch(/^Images 1–2 → MAYA; image 3 → BRUNO \(new character\)\./);
    expect(out.note).toMatch(/Added BRUNO to the cast/);
  });

  it('says so when an owner is full or gone (never silent)', async () => {
    const doc = plannedDoc();
    doc.cast[0].refs = Array.from({ length: 12 }, (_, i) => ref(100 + i));
    const ctx = testContext(newSession(doc));
    const out = await applyAttachmentTargets(ctx, [ref(1), ref(2)], [MAYA, { kind: 'character', id: 'c_gone' }]);
    expect(out.ops).toEqual([]);
    expect(out.note).toMatch(/MAYA already has 12 reference images/);
    expect(out.note).toMatch(/Image 2: that owner no longer exists/);
  });
});

describe('carried images', () => {
  const docWith = (conversation: Msg[]) => {
    const doc = plannedDoc();
    doc.conversation = conversation;
    return doc;
  };

  it('carries the previous message’s unassigned images into a text-only reply', () => {
    const doc = docWith([userMsg('u1', [ref(1), ref(2)], 'who is this?'), botMsg('a1'), userMsg('u2', [], "yes, that's Maya")]);
    expect(carriedImages(doc, []).map((r) => r.path)).toEqual([ref(1).path, ref(2).path]);
  });

  it('skips images that already have an owner, and the current message itself', () => {
    const doc = docWith([userMsg('u1', [ref(1), ref(2)]), botMsg('a1'), userMsg('u2', [ref(3)])]);
    doc.cast[0].refs = [ref(1)];
    // Current turn = u2 (its attachments are `current`): carry ref 2 from u1.
    expect(carriedImages(doc, [ref(3)]).map((r) => r.path)).toEqual([ref(2).path]);
    doc.style.refs = [ref(2)];
    expect(carriedImages(doc, [ref(3)])).toEqual([]);
  });

  it('looks back at most 3 earlier user messages and never carries blocked images', () => {
    const old = docWith([userMsg('u0', [ref(9)]), userMsg('u1'), userMsg('u2'), userMsg('u3'), userMsg('u4')]);
    expect(carriedImages(old, [])).toEqual([]);
    const blocked = docWith([userMsg('u1', [ref(5, { safety: { assessed: 'X', at: 1 } })]), userMsg('u2')]);
    expect(carriedImages(blocked, [])).toEqual([]);
  });

  it('unassignedImages ignores the inbox as an owner', () => {
    const doc = plannedDoc();
    doc.refInbox = [ref(1)];
    expect(unassignedImages(doc, [ref(1)]).map((r) => r.path)).toEqual([ref(1).path]);
  });

  it('whoIsInTheseCard asks one question with the likely owners and replies that resolve next turn', () => {
    const doc = plannedDoc();
    doc.cast[0].refs = [ref(2)];
    const card = whoIsInTheseCard(doc, [ref(1), ref(2), ref(3)]);
    expect(card).toMatchObject({ type: 'options', question: "Who's in these photos?" });
    const choices = (card as Extract<typeof card, { type: 'options' }>).choices;
    expect(choices.map((c) => c.label)).toEqual(['MAYA', 'ARJUN', 'Someone new', 'A style to follow', 'A place']);
    expect(choices[0].reply).toBe('Images 1, 3 are MAYA');
    expect(whoIsInTheseCard(doc, [ref(2)])).toBeNull();
  });
});

describe('refIntentHint (free pre-pass)', () => {
  const doc = () => {
    const d = plannedDoc();
    d.cast[0].refs = [ref(1), ref(2)];
    return d;
  };

  it('the owner’s real pattern: a new pet named in the message', () => {
    expect(refIntentHint("this is my dog bruno, he's in every page", 5, doc())).toBe(
      '(software, may be wrong) images 1–5 → BRUNO (new; "dog" → kind animal).'
    );
  });

  it('existing cast, fuzzy names, numbers and ranges', () => {
    expect(refIntentHint('these are Mya', 3, doc())).toBe('(software, may be wrong) images 1–3 → MAYA (existing, 2 refs).');
    expect(refIntentHint('1-3 are maya and #4 is Arjun', 4, doc())).toBe(
      '(software, may be wrong) images 1–3 → MAYA (existing, 2 refs); image 4 → ARJUN (existing, 0 refs).'
    );
    expect(refIntentHint('1 to 2 are Maya', 2, doc())).toMatch(/images 1–2 → MAYA/);
    expect(refIntentHint('Images 1–5 are MAYA', 5, doc())).toMatch(/images 1–5 → MAYA/);
    expect(refIntentHint('#3 is actually Bruno', 4, doc())).toMatch(/image 3 → BRUNO \(new\)/);
  });

  it('label, style and place cues', () => {
    expect(refIntentHint("3 is Maya's outfit", 3, doc())).toMatch(/"outfit" mentioned for image 3 \(label outfit\)/);
    expect(refIntentHint('draw it like this vibe', 2, doc())).toMatch(/style cue/);
    expect(refIntentHint('this is our house by the lake', 1, doc())).toMatch(/place cue \("our house"\)/);
  });

  it('no match → undefined; ordinary words are not names', () => {
    expect(refIntentHint('', 2, doc())).toBeUndefined();
    expect(refIntentHint('this is awesome', 2, doc())).toBeUndefined();
    expect(refIntentHint('it is raining', 2, doc())).toBeUndefined();
    expect(refIntentHint('this is maya', 0, doc())).toBeUndefined();
    // Without the doc a lower-case word is too weak to call a name.
    expect(refIntentHint('this is maya', 2)).toBeUndefined();
    expect(refIntentHint('This is Maya', 2)).toBe('(software, may be wrong) images 1–2 → MAYA.');
  });

  it('is bounded: a huge message is clipped and still linear', () => {
    const huge = `${'word '.repeat(50_000)}this is Bruno`;
    const t0 = Date.now();
    expect(analyzeAttachmentText(huge, 2)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

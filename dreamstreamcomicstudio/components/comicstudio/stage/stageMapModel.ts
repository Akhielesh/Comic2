// The stage map's words (SH-C2): the five SH-A stages as rows, each done, current (now), next or later, with what is
// left in it and one target that goes there. Pure, from the same StageFacts the strip and the lists read, so the map
// never says something the strip does not. Targets only navigate: the current stage's is its next step (the label and
// place of "Next: …"), every other stage's opens the tab it is worked in. No price, no action.

import { COMIC_STAGES, STAGE_LABEL, STAGE_PLACE, stageView, type ComicStage, type StageFacts, type StagePlace } from '../../../shared/comic/stage';

export type StageMapState = 'done' | 'current' | 'next' | 'later';

export interface StageMapRow {
  stage: ComicStage;
  label: string;
  state: StageMapState;
  /** "Done", "Now", "Next", "Later" (the published comic's last stage reads "Published"). */
  stateWord: string;
  /** What is left in the stage: "6 pages to draw · 2 drawing now", "Nothing left". */
  left: string;
  target: { label: string; place: StagePlace };
  /** The row as one sentence, for a screen reader: "Draw, now. 6 pages to draw, 2 drawing now." */
  sentence: string;
}

const STATE_WORD: Readonly<Record<StageMapState, string>> = { done: 'Done', current: 'Now', next: 'Next', later: 'Later' };

const OPEN_TAB: Readonly<Record<(typeof STAGE_PLACE)[ComicStage], string>> = {
  story: 'Open Story',
  style: 'Open Style',
  pages: 'Open Pages',
  read: 'Open Read'
};

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const NOTHING_LEFT = 'Nothing left';

const leftIn = (stage: ComicStage, done: boolean, complete: boolean, facts: StageFacts): string => {
  switch (stage) {
    case 'story':
      return done ? NOTHING_LEFT : 'No story yet';
    case 'style':
      if (done) return NOTHING_LEFT;
      return facts.looks > 0 ? `${plural(facts.looks, 'look')} to compare` : 'No look chosen yet';
    case 'plan':
      if (done) return NOTHING_LEFT;
      if (!facts.pages) return 'No pages planned yet';
      return facts.planned < facts.pages ? `${plural(facts.pages - facts.planned, 'page')} to plan` : 'The plan is ready to review';
    case 'draw': {
      if (done) return facts.outOfDate ? `${plural(facts.outOfDate, 'page')} out of date` : NOTHING_LEFT;
      if (!facts.pages) return 'Nothing to draw yet';
      const parts = [
        `${plural(facts.pages - facts.drawn, 'page')} to draw`,
        facts.drawing ? `${facts.drawing} drawing now` : '',
        facts.withheld ? `${facts.withheld} withheld` : '',
        facts.failed ? `${facts.failed} failed` : '',
        facts.outOfDate ? `${facts.outOfDate} out of date` : ''
      ];
      return parts.filter(Boolean).join(' · ');
    }
    default:
      if (complete) return facts.next === 'update_published' ? 'Changes not published yet' : NOTHING_LEFT;
      // Live, with a stage before it open again (a page added after publishing): the new work is not out yet.
      if (done) return 'Live · new pages not published yet';
      if (facts.stage !== 'publish') return 'Publish once the pages are drawn';
      return facts.paused ? 'Paused for review' : 'Ready to publish';
  }
};

/** The five rows, in stage order. */
export function stageMapRows(facts: StageFacts): StageMapRow[] {
  const view = stageView(facts);
  const done = new Set(facts.done);
  const at = COMIC_STAGES.indexOf(facts.stage);
  const next = view.complete ? undefined : COMIC_STAGES.slice(at + 1).find((s) => !done.has(s));
  return COMIC_STAGES.map((stage) => {
    const isDone = done.has(stage);
    const state: StageMapState = isDone ? 'done' : stage === facts.stage ? 'current' : stage === next ? 'next' : 'later';
    // The current stage goes to its next step; so does the published comic's last one ("Read your comic", "Publish your
    // changes"). Every other stage opens its tab.
    const leads = state === 'current' || (view.complete && stage === 'publish');
    const target = leads ? { label: view.next.label, place: view.next.place } : { label: OPEN_TAB[STAGE_PLACE[stage]], place: STAGE_PLACE[stage] as StagePlace };
    const stateWord = view.complete && stage === 'publish' ? 'Published' : STATE_WORD[state];
    const left = leftIn(stage, isDone, view.complete, facts);
    const label = STAGE_LABEL[stage];
    return { stage, label, state, stateWord, left, target, sentence: `${label}, ${stateWord.toLowerCase()}. ${left.split(' · ').join(', ')}.` };
  });
}

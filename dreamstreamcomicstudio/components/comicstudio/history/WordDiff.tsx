// Comic History — word-by-word changes of one line (versions plan §5 "Word diff"; package H5).
//
// The shared diffWords / diffLines (shared/comic/history/diff.ts) decide what changed; this only shows it. Removed
// words are struck through and added words underlined — and each carries screen-reader text ("removed:", "added:"),
// so the change never rests on styling alone. The text keeps its language and direction (lang, dir="auto").

import React from 'react';
import { diffWords, type WordDiffPart } from '../../../shared/comic/history/index';

export interface WordDiffProps {
  /** The words then → now. */
  parts?: readonly WordDiffPart[];
  /** Or the two texts (diffed here with the shared diffWords). */
  from?: string;
  to?: string;
  lang?: string;
  className?: string;
}

/**
 * Display grouping of the shared diff: a run of removed / added words separated only by spaces reads as ONE change
 * ("removed: the truth, added: an answer,"), not word by word. The words themselves are diffWords' output.
 */
export const groupWordParts = (parts: readonly WordDiffPart[]): WordDiffPart[] => {
  const out: WordDiffPart[] = [];
  let i = 0;
  while (i < parts.length) {
    if (parts[i].op === 'same') {
      out.push(parts[i]);
      i += 1;
      continue;
    }
    let last = i;
    let k = i;
    while (k < parts.length && (parts[k].op !== 'same' || /^\s+$/.test(parts[k].text))) {
      if (parts[k].op !== 'same') last = k;
      k += 1;
    }
    let del = '';
    let add = '';
    for (let x = i; x <= last; x += 1) {
      const q = parts[x];
      if (q.op === 'del') del += q.text;
      else if (q.op === 'add') add += q.text;
      else {
        if (del) del += q.text;
        if (add) add += q.text;
      }
    }
    del = del.trimEnd();
    add = add.trimEnd();
    if (del) out.push({ op: 'del', text: del });
    if (del && add) out.push({ op: 'same', text: ' ' });
    if (add) out.push({ op: 'add', text: add });
    i = last + 1;
  }
  return out;
};

export const WordDiff: React.FC<WordDiffProps> = ({ parts, from, to, lang, className }) => {
  const list = groupWordParts(parts ?? diffWords(from ?? '', to ?? ''));
  return (
    <span dir="auto" lang={lang} className={className} data-word-diff>
      {list.map((p, i) => {
        if (p.op === 'same') return <span key={i}>{p.text}</span>;
        if (p.op === 'del')
          return (
            <del key={i} className="text-[var(--ds-muted)] decoration-[var(--ds-danger-mark)] decoration-2">
              <span className="sr-only">removed: </span>
              {p.text}
            </del>
          );
        return (
          <ins key={i} className="font-medium text-[var(--ds-ink)] underline decoration-[var(--ds-success)] decoration-2 underline-offset-2">
            <span className="sr-only">added: </span>
            {p.text}
          </ins>
        );
      })}
    </span>
  );
};

export default WordDiff;

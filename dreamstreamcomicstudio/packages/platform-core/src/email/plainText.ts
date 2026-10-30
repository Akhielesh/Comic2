/**
 * `emailToPlainText(doc)`: the body as plain text, which a composer fills in as-is (Atlas's body textarea, the
 * text/plain alternative of an HTML mail, Copy text). It is the body only: the subject, preheader and recipients
 * travel separately, and attachments are prepared by the host.
 *
 * - Every link shows its full URL: `text (https://…)`, or the URL alone when the text already is it.
 * - A link that is not `https:`/`mailto:` is dropped; its text stays.
 * - Lists use `- ` / `1. `, quotes `> `, a divider `---`, an image `[Image: alt]`, columns follow each other.
 * - The signature follows the standard `-- ` delimiter line.
 */
import type { EmailDoc } from '../contract/email.js';
import { readDoc, type ReadBlock, type ReadRun } from './read.js';

const runLink = (r: ReadRun): string => {
  if (!r.href) return r.text;
  const t = r.text.trim();
  if (t === r.href || `mailto:${t}` === r.href || t === '') return t === '' ? r.href : r.text;
  return `${r.text} (${r.href})`;
};

/** Inline runs as one string, links spelled out. */
export const runsToText = (runs: readonly ReadRun[]): string => runs.map(runLink).join('');

/** Indent every line after the first by `pad` (list items that wrap onto new lines). */
const hang = (text: string, pad: string): string => text.split('\n').join(`\n${pad}`);

const blockText = (b: ReadBlock): string => {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
      return runsToText(b.runs);
    case 'list': {
      let n = 0;
      return b.items
        .map((it) => {
          n++;
          const prefix = `${'  '.repeat(it.indent)}${b.ordered ? `${n}.` : '-'} `;
          return prefix + hang(runsToText(it.runs), ' '.repeat(prefix.length));
        })
        .join('\n');
    }
    case 'button':
      if (!b.label.trim()) return b.href;
      return b.href ? `${b.label}: ${b.href}` : b.label;
    case 'quote': {
      const lines = runsToText(b.runs).split('\n');
      if (b.cite) lines.push(`— ${b.cite}`);
      return lines.map((l) => (l ? `> ${l}` : '>')).join('\n');
    }
    case 'divider':
      return '---';
    case 'image':
      return b.alt.trim() ? `[Image: ${b.alt.trim()}]` : '[Image]';
    case 'columns':
      return b.columns
        .map((col) => col.map(blockText).filter((t) => t !== '').join('\n\n'))
        .filter((t) => t !== '')
        .join('\n\n');
  }
};

/** The body of a draft as plain text (see the module comment). Pure; never throws. */
export const emailToPlainText = (doc: EmailDoc): string => {
  const d = readDoc(doc);
  const parts = d.blocks.map(blockText).filter((t) => t !== '');
  let out = parts.join('\n\n');
  const sig = d.signature.replace(/\s+$/, '');
  if (sig) out += `${out ? '\n\n' : ''}-- \n${sig}`;
  return out;
};

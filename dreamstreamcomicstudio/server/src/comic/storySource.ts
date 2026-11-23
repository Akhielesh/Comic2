// The outline and the five-page writers share a fixed source budget. A single
// head/tail slice used to hide the same middle chapters from every writer.
const GAP = '\n[…]\n';

function excerpt(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const width = Math.floor((budget - 2 * GAP.length) / 3);
  const middle = Math.floor((text.length - width) / 2);
  return [text.slice(0, width), text.slice(middle, middle + width), text.slice(-width)].join(GAP);
}

export function longStorySource(script: string, count: number, budget: number, requested?: readonly number[]): string {
  if (script.length <= budget) return script;
  // Trust page markers only when they form the entire sequential manuscript.
  // A stray "Page 2" or a mismatch in adaptation length is not a page map.
  const headings = [...script.matchAll(/^[\t ]*(?:#{1,4}[\t ]+)?(?:page|pg\.)[\t ]+(\d{1,3})[\t ]*(?=[:.\u2014\u2013-]|\r?$)/gim)];
  const marked = headings.length === count && headings.every((h, i) => Number(h[1]) === i + 1);
  const pages = Array.from({ length: count }, (_, i) => {
    const start = marked ? headings[i].index! : Math.floor(i * script.length / count);
    const end = marked ? (headings[i + 1]?.index ?? script.length) : Math.floor((i + 1) * script.length / count);
    return { n: i + 1, text: script.slice(start, end) };
  });
  const wanted = new Set(requested);
  const selected = requested?.length ? pages.filter(page => wanted.has(page.n)) : pages;
  const sections = selected.length ? selected : pages;
  const preamble = marked ? excerpt(script.slice(0, headings[0].index).trim(), 2400) : '';
  const wholeSection = sections.map(page => page.text).join('');
  if (sections.every((page, i) => page.n === sections[0].n + i) && wholeSection.length + preamble.length + 2 <= budget) {
    return [preamble, wholeSection].filter(Boolean).join('\n\n');
  }
  const allowance = Math.floor((budget - preamble.length - sections.length * 40 - 4) / sections.length);
  const entries = sections.map(page => (marked ? '' : `[Source passage ${page.n} of ${count}]\n`) + excerpt(page.text, allowance));
  return [preamble, ...entries].filter(Boolean).join('\n\n');
}

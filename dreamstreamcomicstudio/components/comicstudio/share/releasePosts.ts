import { graphemes } from '../../../shared/comic/textLayout';
import { type PublicationOwnerView } from '../../../shared/comic/publication';
import { type IntentChannel, shareLinkFor } from './shareModel';

export type ReleaseChannel = IntentChannel | 'linkedin';
export type ReleaseGoal = 'read' | 'feedback';
export interface ReleasePost { subject: string; body: string; footer: string }
export const X_POST_LIMIT = 280;

const urlPattern = /https?:\/\/[^\s<>"“”]+/giu;
const words = (text: string | undefined) => (text || '').replace(urlPattern, '').replace(/\s+/gu, ' ').trim();

export function hasPrivateFileLink(text: string): boolean {
  return (text.match(urlPattern) || []).some((value) => {
    try {
      const url = new URL(value);
      return /\/storage\/v1\/(?:object|render\/image)\/sign(?:\/|$)/i.test(url.pathname)
        || [...url.searchParams.keys()].some((key) => /^(?:token|access_token|signature|sig|x-amz-(?:signature|credential)|x-goog-(?:signature|credential))$/i.test(key));
    } catch { return false; }
  });
}

// A conservative bound for X. Count wide code points separately even inside emoji clusters.
// Each web link counts at least 23 and long links use their full length.
function codePointWeight(text: string): number {
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    total += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return total;
}

export function xWeight(text: string): number {
  let weight = codePointWeight(text);
  for (const [link] of text.matchAll(urlPattern)) weight += Math.max(0, 23 - codePointWeight(link));
  return weight;
}

function fitForX(text: string, budget: number): string {
  if (xWeight(text) <= budget) return text;
  let result = '';
  let remaining = budget - codePointWeight('…');
  for (const cluster of graphemes(text)) {
    const cost = codePointWeight(cluster);
    if (cost > remaining) break;
    remaining -= cost;
    result += cluster;
  }
  return result.trimEnd() + '…';
}

export function releasePost(view: PublicationOwnerView, channel: ReleaseChannel, goal: ReleaseGoal): ReleasePost | null {
  if (view.status !== 'live' || view.visibility === 'private') return null;
  const url = shareLinkFor(view, { via: channel });
  if (!url) return null;
  const title = words(view.card?.title) || 'My comic';
  const hook = words(view.card?.description);
  const pages = view.card?.pageCount;
  const length = typeof pages === 'number' && Number.isInteger(pages) && pages > 0 ? `${pages}-page comic` : 'comic';
  const feedback = goal === 'feedback';
  const footer = [view.rating && `Rated ${view.rating}`, url].filter(Boolean).join('\n');
  const paragraphs = (...parts: string[]) => parts.filter(Boolean).join('\n\n');
  let subject = '';
  let body: string;
  switch (channel) {
    case 'email':
      subject = feedback ? `A reader’s question about ${title}` : `An invitation to read ${title}`;
      body = paragraphs('Hi,', `I’d like to share my ${length}, “${title}”, with you.`, hook,
        feedback ? 'If you have a moment after reading, could you reply with the scene that stood out to you? I’d love to hear why.' : 'The full comic is at the link below. I hope you enjoy reading it.');
      break;
    case 'whatsapp':
      body = paragraphs(`Hey! I made a ${length} called “${title}”.`, hook,
        feedback ? 'Which panel stuck with you? Message me after you read it.' : 'Here’s the link if you want to read it.');
      break;
    case 'telegram':
      body = paragraphs(`Comic release · ${title}`, hook,
        feedback ? 'After reading, send me a panel number and tell me what caught your eye.' : `Open the link below to read the full ${length}.`);
      break;
    case 'facebook':
      body = paragraphs(`I’m sharing “${title}” with the group today.`, hook,
        feedback ? 'If you read it, which scene would you like to talk about? I’d love to hear in the comments.' : 'The link opens the comic in your browser. Save this post if you’d like to read it later.');
      break;
    case 'linkedin':
      body = paragraphs(`I’ve published “${title}”, a ${length}.`, hook,
        feedback ? 'I’d welcome feedback on how the artwork and pacing carry the story. Which page worked best for you?' : 'The published edition is available to read below.');
      break;
    case 'x': {
      const invitation = feedback ? 'Which panel stayed with you?' : 'Read the comic.';
      const suffix = `\n${invitation}`;
      const intro = [title, hook].filter(Boolean).join(' — ');
      body = fitForX(intro, X_POST_LIMIT - xWeight(suffix + '\n\n' + footer)) + suffix;
      break;
    }
  }
  return { subject, body, footer };
}

export const releasePostText = (post: ReleasePost): string => [post.body.trim(), post.footer].filter(Boolean).join('\n\n');

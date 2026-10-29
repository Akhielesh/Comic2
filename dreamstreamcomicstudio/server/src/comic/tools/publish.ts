// Director tool group "publish" (contract §12.1/§12.2; sharing.md §9). Owner: P1-PUBLISH.
//
//   publish_comic · get_share_link · unpublish_comic · update_publication      all FREE
//
// These tools NEVER act. Each posts a `publish` (or `share`) card into the director's message
// and returns an honest sentence; the user's tap on the card sends the StudioAction that does
// the work (actions/publish.ts). So the director can never publish, re-link or unpublish a
// comic on its own, and it can never claim it did (prompt rule below).
// Phase gate: at least one page drawn, or a publication exists.

import { newId, type Card, type ComicDoc } from '../../../../shared/comic/doc.js';
import { editionReadiness } from '../../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import { buildShareUrl, type PublishRequest } from '../../../../shared/comic/publication.js';
import { COMICS_ORIGIN } from '../../../../services/productHost.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup } from '../extensions.js';
import { getReadiness } from '../publication/publication.js';
import { drawnPages } from '../publication/snapshot.js';
import { safetyDeps } from '../safety/deps.js';
import type { DirectorTurn } from '../tools.js';
import type { StudioContext } from '../types.js';

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const langName = (l: string) => languageSpec(l)?.english || l;

const isLive = (doc: ComicDoc) => !!doc.publication && doc.publication.status === 'live' && !!doc.publication.slug;

/**
 * The LIVE moderation hold on this comic, read the way the Share sheet's publish reads it
 * (publishWithOutcome → projects.is_forced_private). The doc mirror keeps saying 'suspended' after a
 * moderator lifts a hold — the row stays suspended until the owner republishes — so the mirror alone
 * can never decide. null = couldn't tell (lookup failed, no row, or not this user's comic): the
 * caller refuses honestly rather than guess either way.
 */
async function liveHold(ctx: StudioContext): Promise<boolean | null> {
  try {
    const info = await safetyDeps().store.projectInfo(ctx.projectId);
    if (!info || info.ownerUserId !== ctx.userId) return null;
    return info.isForcedPrivate;
  } catch {
    return null;
  }
}

const PAUSED_MESSAGE = 'This comic is paused by moderation, so it cannot be published right now. Tell the user plainly; do not retry.';
const UNKNOWN_HOLD_MESSAGE =
  "Couldn't check whether the moderation pause on this comic has been lifted, so it can't be published from here right now. Tell the user plainly; they can try again in a moment or from the Share sheet.";

/** "Published: unlisted · /c/Ab3…" for the DOC SUMMARY (never the full slug in the prompt). */
export function publicationSummary(doc: ComicDoc): string[] {
  const m = doc.publication;
  if (!m) return ['Published: no (private). Offer publish_comic (unlisted) when every planned page is drawn.'];
  if (m.status === 'suspended') {
    return [
      'Published: paused by moderation — readers see "This link isn\'t active". Only if the user asks to publish again, call publish_comic: it checks whether the pause was lifted (a fresh publish that brings the same link back) and refuses otherwise.'
    ];
  }
  const langs = m.languages.map(langName).join(', ');
  return [`Published: ${m.visibility} · /c/${(m.slug || '').slice(0, 3)}… · ${langs}. Later edits stay private until the user taps "Update" (publish_comic offers it).`];
}

const PROMPT_RULES = [
  'PUBLISHING (tools publish_comic, get_share_link, unpublish_comic, update_publication — all free):',
  '- These tools only SHOW a card; the user taps it to publish. Never say a comic is published, shared, re-linked or unpublished until a `publication` change or a notice confirms it.',
  '- Suggest publishing when every planned page is drawn and fresh. Default to UNLISTED (anyone with the link); mention that public also lists it in the gallery.',
  '- When the user asks for "a link", call get_share_link. If the comic is not published yet, propose publish_comic with unlisted.',
  '- Share links are read-only: readers can read and (unless turned off) download, never edit.'
].join('\n');

const str = (v: unknown, max = 40): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

function readLanguages(doc: ComicDoc, raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length) throw toolArgError('languages must be a non-empty list of language codes like ["en","hi"].');
  const out: string[] = [];
  for (const l of raw) {
    if (typeof l !== 'string' || !LANG_RE.test(l)) throw toolArgError(`"${String(l).slice(0, 20)}" is not a language code.`);
    if (!out.some((x) => sameLanguage(x, l))) out.push(l);
  }
  if (out.length > 12) throw toolArgError('At most 12 languages.');
  const source = doc.format.language;
  const editions = Object.keys(doc.i18n?.editions || {});
  const unknown = out.filter((l) => !sameLanguage(l, source) && !editions.some((e) => sameLanguage(e, l)));
  if (unknown.length) throw toolArgError(`No ${unknown.map(langName).join(', ')} edition exists yet. Editions: ${[source, ...editions].map(langName).join(', ')}.`);
  return out;
}

const publishCard = (mode: 'publish' | 'update' | 'unpublish' | 'regenerate', request?: PublishRequest): Card => ({
  type: 'publish',
  id: newId('card'),
  mode,
  ...(request ? { request } : {}),
  status: 'pending'
});

function tools(ctx: StudioContext, turn: DirectorTurn): DirectorTool[] {
  const doc = () => ctx.session.doc;

  const publishComic = defineTool(
    'publish_comic',
    'free',
    'Show the user a Publish card (it does NOT publish — the user taps it). Unlisted = anyone with the link; public = also in the gallery. Links are read-only; readers may download unless allow_download is false.',
    {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['unlisted', 'public'] },
        languages: { type: 'array', items: { type: 'string' }, description: 'Editions to publish (source language and/or finished translations).' },
        default_language: { type: 'string' },
        start_page: { type: 'integer', minimum: 1 },
        allow_download: { type: 'boolean' }
      },
      required: ['visibility']
    },
    async (args) => {
      const d = doc();
      const visibility = args.visibility === 'public' ? 'public' : args.visibility === 'unlisted' ? 'unlisted' : null;
      if (!visibility) throw toolArgError('visibility must be "unlisted" or "public".');
      if (d.publication?.status === 'suspended') {
        // Same rule as the Share sheet (publishWithOutcome): the live hold decides, never the mirror alone.
        const held = await liveHold(ctx);
        if (held === null) return UNKNOWN_HOLD_MESSAGE;
        if (held) return PAUSED_MESSAGE;
        // Lifted: the row is still suspended, so this is a fresh publish (same link, fresh copies), not an update.
      }
      const languages = readLanguages(d, args.languages);
      const request: PublishRequest = { visibility };
      if (languages) request.languages = languages;
      const def = str(args.default_language, 20);
      if (def) {
        if (!LANG_RE.test(def)) throw toolArgError('default_language must be a language code.');
        request.defaultLang = def;
      }
      const start = int(args.start_page);
      if (start !== undefined) request.startPage = Math.max(1, Math.min(500, start));
      const allowDownload = bool(args.allow_download);
      if (allowDownload !== undefined) request.allowDownload = allowDownload;

      const readiness = await getReadiness(ctx, d, request);
      if (!readiness.drawnPages) return 'Not ready: no page is drawn yet. Offer to draw the pages first (nothing was shown).';
      const busy = d.pages.filter((p) => p.render.status === 'queued' || p.render.status === 'rendering').map((p) => p.n);
      const blockers: string[] = [];
      if (busy.length) blockers.push(`page ${busy.join(', ')} still drawing`);
      // Only the editions this card would publish can block it (readiness lists every edition the doc holds).
      for (const l of readiness.languages.filter((x) => x.requested !== false && !x.publishable)) blockers.push(`${langName(l.lang)}: ${l.blocking[0] || 'not finished'}`);
      if (readiness.safety.blockedPages.length) blockers.push(`page ${readiness.safety.blockedPages.join(', ')} blocked by the content rules (the card can publish without ${readiness.safety.blockedPages.length === 1 ? 'it' : 'them'})`);
      const mode = isLive(d) ? 'update' : 'publish';
      turn.cards.push(publishCard(mode, request));
      const missing = readiness.missing.filter((m) => m.kind === 'page').map((m) => m.n);
      const parts = [
        `${mode === 'update' ? 'Update' : 'Publish'} card shown: ${visibility}, ${readiness.drawnPages}/${readiness.plannedPages} pages drawn`,
        missing.length ? `pages ${missing.join(', ')} not drawn (they would be left out)` : '',
        `safety: ${readiness.safety.status === 'cleared' ? 'cleared' : readiness.safety.status === 'blocked' ? 'some pages blocked' : 'will be checked when they tap Publish'}`
      ].filter(Boolean);
      return `${parts.join(', ')}.${blockers.length ? ` Heads-up: ${blockers.join('; ')}.` : ''} Waiting for the user to confirm — it is NOT published yet.`;
    }
  );

  const getShareLink = defineTool(
    'get_share_link',
    'free',
    'Get the read-only share link of the published comic (optionally opening at a language or page) and show the Share card.',
    { type: 'object', properties: { language: { type: 'string' }, page: { type: 'integer', minimum: 1 } } },
    async (args) => {
      const d = doc();
      const m = d.publication;
      if (!m || !m.slug) return 'Not published yet — offer publish_comic with visibility "unlisted".';
      if (m.status === 'suspended') return 'The link is paused by moderation; readers currently see "This link isn\'t active". Do not share it.';
      const lang = str(args.language, 20);
      if (lang && !m.languages.some((l) => sameLanguage(l, lang))) {
        return `The ${langName(lang)} edition isn't published. Published: ${m.languages.map(langName).join(', ')}.${editionReadiness(d, lang).publishable ? ' It is ready — offer update_publication via publish_comic with that language.' : ''}`;
      }
      const page = int(args.page);
      const url = buildShareUrl(COMICS_ORIGIN, m.slug, { ...(lang ? { lang } : {}), ...(page ? { page } : {}) });
      turn.cards.push({ type: 'share', id: newId('card') });
      const ago = Math.max(0, Math.round((Date.now() - m.publishedAt) / 3_600_000));
      return `Link: ${url} (${m.visibility}, published ${ago < 1 ? 'under an hour' : `${ago} h`} ago). Share card shown. Give the user this exact link.`;
    }
  );

  const unpublishComic = defineTool(
    'unpublish_comic',
    'free',
    'Show an Unpublish card (it does NOT unpublish — the user must confirm). Unpublishing turns the link off for everyone; publishing again creates a NEW link.',
    { type: 'object', properties: {} },
    async () => {
      const d = doc();
      if (!d.publication) return 'The comic is not published, so there is nothing to unpublish.';
      turn.cards.push(publishCard('unpublish'));
      return 'Unpublish card shown. The link keeps working until the user confirms.';
    }
  );

  const updatePublicationTool = defineTool(
    'update_publication',
    'free',
    'Show a card that changes publication settings (visibility, default language, start page, downloads) or gets a NEW link (regenerate_link: the old link stops working). Nothing changes until the user taps.',
    {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['unlisted', 'public'] },
        default_language: { type: 'string' },
        start_page: { type: 'integer', minimum: 1 },
        allow_download: { type: 'boolean' },
        regenerate_link: { type: 'boolean' }
      }
    },
    async (args) => {
      const d = doc();
      const m = d.publication;
      if (!m || m.status !== 'live') return 'Not published — offer publish_comic instead.';
      if (args.regenerate_link === true) {
        turn.cards.push(publishCard('regenerate'));
        return 'New-link card shown. The current link keeps working until the user confirms; after that it stops working for everyone.';
      }
      const request: PublishRequest = { visibility: args.visibility === 'public' || args.visibility === 'unlisted' ? args.visibility : m.visibility, languages: [...m.languages] };
      const def = str(args.default_language, 20);
      if (def) request.defaultLang = def;
      const start = int(args.start_page);
      if (start !== undefined) request.startPage = Math.max(1, Math.min(500, start));
      const allowDownload = bool(args.allow_download);
      if (allowDownload !== undefined) request.allowDownload = allowDownload;
      if (Object.keys(request).length <= 2 && request.visibility === m.visibility) return 'Nothing to change. Settings: visibility, default_language, start_page, allow_download, regenerate_link.';
      turn.cards.push(publishCard('update', request));
      return `Update card shown (${request.visibility}${request.allowDownload === false ? ', downloads off' : ''}). Tapping Update republishes the current version with these settings, so any edits made since publishing go live too (after the safety check) — tell the user that plainly. Nothing changes until the user taps.`;
    }
  );

  return [publishComic, getShareLink, unpublishComic, updatePublicationTool];
}

export const publishToolGroup: ToolGroup = {
  id: 'publish',
  priority: 40,
  when: (ctx) => {
    const doc = ctx.session.doc;
    return !!doc.publication || drawnPages(doc).length > 0;
  },
  tools,
  promptRules: () => PROMPT_RULES,
  summaryLines: (doc) => publicationSummary(doc),
  activity: {
    publish_comic: 'Preparing the publish card…',
    get_share_link: 'Getting the share link…',
    unpublish_comic: 'Preparing the unpublish card…',
    update_publication: 'Preparing the link settings…'
  }
};

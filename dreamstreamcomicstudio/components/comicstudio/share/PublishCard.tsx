// Conversation card "publish" (sharing.md §9): the director only ever SHOWS this card; the
// user's tap sends the action. Modes: publish / update / unpublish / regenerate. Destructive
// modes need a second tap. Running → honest progress; done → the link with Copy / Share… / Open
// Share sheet; failed → the reason, Retry, and "Publish without page N" for safety blocks.

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Globe2, Link2, Loader2, Share2 } from 'lucide-react';
import type { Card } from '../../../shared/comic/doc';
import type { CardProps } from '../extensions';
import { CardShell, GhostButton, PrimaryButton, cx } from '../conversation/ui';
import { useAction } from '../conversation/cards/useAction';
import { readinessRows } from './PublishPanel';
import { ShareSheet } from './ShareSheet';
import { comicTitle } from './shareModel';
import { useShareCapabilities } from './useShareCapabilities';

type PublishCardData = Extract<Card, { type: 'publish' }>;

const big = 'min-h-[44px] px-4';

export const PublishCard: React.FC<CardProps<PublishCardData>> = ({ card, studio }) => {
  const { run, isPending } = useAction(studio.act);
  const caps = useShareCapabilities();
  const [armed, setArmed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState(false);
  const doc = studio.doc;
  const title = comicTitle(doc);
  const destructive = card.mode === 'unpublish' || card.mode === 'regenerate';
  const visibility = card.request?.visibility ?? doc?.publication?.visibility ?? 'unlisted';

  useEffect(() => {
    if (card.status === 'pending' && !studio.publication && !destructive) studio.refreshPublication().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.status]);

  const heading =
    card.mode === 'unpublish' ? `Unpublish “${title}”?` : card.mode === 'regenerate' ? 'Get a new link?' : card.mode === 'update' ? 'Update the published version?' : `Publish “${title}”?`;

  const actionFor = (excludePageIds?: string[]) => {
    if (card.mode === 'unpublish') return { type: 'unpublish' as const, cardId: card.id };
    if (card.mode === 'regenerate') return { type: 'regenerate_link' as const, cardId: card.id };
    const request = { ...(card.request || { visibility }), ...(excludePageIds?.length ? { excludePageIds } : {}) };
    return { type: 'publish' as const, cardId: card.id, request };
  };

  const go = (excludePageIds?: string[]) => {
    if (destructive && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    void run('go', actionFor(excludePageIds));
  };

  if (!doc) return null;
  const running = card.status === 'running' || isPending('go');
  const url = card.result?.url;
  const blockers = (card.result?.blockers || []).filter((b) => b.target.kind === 'page');
  const blockedIds = blockers.map((b) => (b.target as { id: string }).id);
  const blockedNs = (doc?.pages || []).filter((p) => blockedIds.includes(p.id)).map((p) => p.n);

  return (
    <CardShell
      title={heading}
      icon={visibility === 'public' ? <Globe2 className="h-4 w-4" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
      right={!destructive ? (visibility === 'public' ? 'Public gallery' : 'Anyone with the link') : undefined}
      aria-label={heading}
    >
      {card.status === 'pending' && !destructive && (
        <ul className="m-0 mb-3 list-none space-y-1 p-0 text-[13px] text-[var(--ds-ink)]">
          {readinessRows(studio.publication?.readiness, doc!).map((r, i) => (
            <li key={i} className="flex min-w-0 items-start gap-2">
              <span aria-hidden className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', r.ok === true ? 'bg-emerald-500' : r.ok === 'warn' ? 'bg-amber-500' : 'bg-[var(--ds-hairline)]')} />
              <span className="min-w-0">{r.text}</span>
            </li>
          ))}
          <li className="text-[12px] text-[var(--ds-muted)]">Read-only link{card.request?.allowDownload === false ? '' : ' · readers can download'} · free</li>
        </ul>
      )}
      {card.status === 'pending' && destructive && (
        <p className="m-0 mb-3 text-[13px] text-[var(--ds-ink)]">
          {card.mode === 'unpublish' ? 'The link stops working for everyone. Publishing again creates a new link.' : 'The current link stops working for everyone right away.'}
        </p>
      )}
      {running && (
        <p role="status" className="m-0 mb-3 flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {card.mode === 'unpublish' ? 'Turning the link off…' : card.mode === 'regenerate' ? 'Making a new link…' : 'Publishing… copying pages and making the preview image'}
        </p>
      )}
      {card.status === 'done' && (
        <div className="space-y-2">
          <p className="m-0 flex items-center gap-2 text-[13px] text-[var(--ds-ink)]">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            {card.mode === 'unpublish' ? 'Unpublished.' : card.mode === 'regenerate' ? 'New link ready — the old one no longer works.' : 'Published.'}
          </p>
          {url && (
            <>
              <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} className="h-11 w-full min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 font-mono text-[12px] text-[var(--ds-ink)]" />
              <div className="flex flex-wrap gap-2">
                <GhostButton className={big} onClick={async () => setCopied(await caps.copy(url))}>
                  {copied ? 'Copied' : 'Copy'}
                </GhostButton>
                <GhostButton className={big} onClick={() => void caps.share({ title, url }).then((r) => r === 'fallback' && setSheet(true))}>
                  <Share2 className="h-4 w-4" aria-hidden /> Share…
                </GhostButton>
                <PrimaryButton className={big} onClick={() => setSheet(true)}>
                  Open Share sheet
                </PrimaryButton>
              </div>
              <span className="sr-only" aria-live="polite">
                {copied ? 'Link copied' : ''}
              </span>
            </>
          )}
        </div>
      )}
      {card.status === 'failed' && (
        <p role="alert" className="m-0 mb-3 rounded-xl border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[13px] text-[var(--ds-ink)]">
          {card.result?.error || "That didn't work. Nothing changed."}
        </p>
      )}
      {card.status === 'declined' && <p className="m-0 text-[13px] text-[var(--ds-muted)]">Not published — nothing changed.</p>}
      {(card.status === 'pending' || card.status === 'failed') && !running && (
        <div className="flex flex-wrap items-center gap-2">
          {card.status === 'failed' && blockedIds.length > 0 && card.mode !== 'unpublish' && card.mode !== 'regenerate' && (
            <GhostButton className={big} onClick={() => go(blockedIds)}>
              Publish without page {blockedNs.join(', ') || blockedIds.length}
            </GhostButton>
          )}
          {destructive ? (
            <button
              type="button"
              onClick={() => go()}
              className={cx(big, 'inline-flex items-center justify-center rounded-xl bg-red-600 text-[13px] font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50')}
            >
              {armed ? 'Tap again to confirm' : card.status === 'failed' ? 'Retry' : card.mode === 'unpublish' ? 'Unpublish' : 'Get new link'}
            </button>
          ) : (
            <PrimaryButton className={big} onClick={() => go()}>
              {card.status === 'failed' ? 'Retry' : card.mode === 'update' ? 'Update' : 'Publish'}
            </PrimaryButton>
          )}
          {card.status === 'pending' && (
            <GhostButton className={big} onClick={() => void run('decline', { type: 'decline_publish', cardId: card.id })} busy={isPending('decline')}>
              Not now
            </GhostButton>
          )}
        </div>
      )}
      {sheet && <ShareSheet studio={studio} open={sheet} onClose={() => setSheet(false)} />}
    </CardShell>
  );
};

export default PublishCard;

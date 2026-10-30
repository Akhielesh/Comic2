// Conversation card "share": the live link of the published comic (from the doc mirror) with
// Copy / Share… / Open Share sheet — or, when private, an honest note and a way to publish.

import React, { useState } from 'react';
import { Link2, Share2 } from 'lucide-react';
import type { Card } from '../../../shared/comic/doc';
import { buildShareUrl } from '../../../shared/comic/publication';
import { COMICS_ORIGIN } from '../../../services/productHost';
import type { CardProps } from '../extensions';
import { CardShell, GhostButton, PrimaryButton } from '../conversation/ui';
import { ShareSheet } from './ShareSheet';
import { comicTitle } from './shareModel';
import { useShareCapabilities } from './useShareCapabilities';

type ShareCardData = Extract<Card, { type: 'share' }>;

export const ShareCardView: React.FC<CardProps<ShareCardData>> = ({ studio }) => {
  const caps = useShareCapabilities();
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState(false);
  const m = studio.doc?.publication;
  const title = comicTitle(studio.doc);
  const url = m?.slug && m.status === 'live' ? buildShareUrl(COMICS_ORIGIN, m.slug) : null;
  return (
    <CardShell title={url ? 'Your share link' : 'Not shared yet'} icon={<Link2 className="h-4 w-4" aria-hidden />} right={url ? (m!.visibility === 'public' ? 'Public' : 'Unlisted') : undefined}>
      {url ? (
        <div className="space-y-2">
          <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} className="h-11 w-full min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 font-mono text-[12px] text-[var(--ds-ink)]" />
          <div className="flex flex-wrap gap-2">
            <GhostButton className="min-h-[44px] px-4" onClick={async () => setCopied(await caps.copy(buildShareUrl(COMICS_ORIGIN, m!.slug!, { via: 'copy' })))}>
              {copied ? 'Copied' : 'Copy'}
            </GhostButton>
            <GhostButton className="min-h-[44px] px-4" onClick={() => void caps.share({ title, url: buildShareUrl(COMICS_ORIGIN, m!.slug!, { via: 'native' }) }).then((r) => r === 'fallback' && setSheet(true))}>
              <Share2 className="h-4 w-4" aria-hidden /> Share…
            </GhostButton>
            <PrimaryButton className="min-h-[44px] px-4" onClick={() => setSheet(true)}>
              Open Share sheet
            </PrimaryButton>
          </div>
          <p className="m-0 text-[12px] text-[var(--ds-muted)]">Read-only: people can read{studio.publication?.allowDownload === false ? '' : ' and download'}, never edit.</p>
          <span className="sr-only" aria-live="polite">
            {copied ? 'Link copied' : ''}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="m-0 text-[13px] text-[var(--ds-muted)]">{m?.status === 'suspended' ? 'This link is paused while our team reviews it.' : 'Only you can see this comic right now.'}</p>
          <PrimaryButton className="min-h-[44px] px-4" onClick={() => setSheet(true)}>
            Share options
          </PrimaryButton>
        </div>
      )}
      {sheet && <ShareSheet studio={studio} open={sheet} onClose={() => setSheet(false)} />}
    </CardShell>
  );
};

export default ShareCardView;

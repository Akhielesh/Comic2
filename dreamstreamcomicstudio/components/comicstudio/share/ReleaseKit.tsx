import React, { useId, useState } from 'react';
import { type PublicationOwnerView, SLUG_RE, ratedDescription } from '../../../shared/comic/publication';
import { CONTROL_BTN, FOCUS_RING } from '../../chat/studioDesign';
import { CHANNEL_LABEL, INTENT_CHANNELS, type IntentChannel, shareLinkFor } from './shareModel';
import { copyText } from './useShareCapabilities';

function nextReleaseStep(view: PublicationOwnerView): string {
  if (view.behind) return 'Preview the version readers get. Use Update if you want to release your latest edits.';
  const stats = view.stats;
  if (!stats) return 'Copy a post for one channel. Return here after people have had time to read.';
  const opens = Object.values(stats.byChannel7d).reduce((a, b) => a + b, 0);
  if (!opens) return 'No opens were recorded in the last seven days. Pick a channel for your next post.';
  if (!stats.completes7d) return 'Readers have opened the comic. Try reading from the cover to the last page before sharing it again.';
  const ranked = INTENT_CHANNELS.map((channel) => ({ channel, count: stats.byChannel7d[channel] || 0 }))
    .sort((a, b) => b.count - a.count);
  if (ranked[0].count > ranked[1].count) {
    const { channel, count } = ranked[0];
    return `${CHANNEL_LABEL[channel]} links recorded ${count} ${count === 1 ? 'open' : 'opens'} in seven days, the most of your posting channels. Try it for your next release.`;
  }
  return 'Readers reached the last page. Compare the channel counts below when choosing where to share your next release.';
}

export function ReleaseKit({ view }: { view: PublicationOwnerView }) {
  const [channel, setChannel] = useState<IntentChannel>('email');
  const [feedback, setFeedback] = useState('');
  const id = useId();
  if (view.status !== 'live' || !view.slug || !SLUG_RE.test(view.slug) || (view.visibility !== 'public' && view.visibility !== 'unlisted')) return null;
  const link = shareLinkFor(view, { via: channel });
  if (!link) return null;
  const post = [view.card?.title || 'Read this comic', ratedDescription(view.card?.description || '', view.rating), link].filter(Boolean).join('\n\n');
  return (
    <details className="rounded-xl border border-[var(--ds-hairline)] px-3 text-[13px] text-[var(--ds-ink)]">
      <summary className={`min-h-11 cursor-pointer content-center font-semibold ${FOCUS_RING}`}>Plan a release post</summary>
      <div className="space-y-3 pb-3">
        <p className="m-0">{view.visibility === 'unlisted' ? 'Anyone receiving this link can pass it on. Your comic stays off the Library shelf.' : 'Your comic is listed in the Library. You can also share its reader link directly.'}</p>
        <label htmlFor={id} className="block font-medium">Where will you share it?</label>
        <select id={id} value={channel} onChange={(event) => { setChannel(event.target.value as IntentChannel); setFeedback(''); }}
          className={`min-h-11 w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-2 ${FOCUS_RING}`}>
          {INTENT_CHANNELS.map((ch) => <option key={ch} value={ch}>{CHANNEL_LABEL[ch]}</option>)}
        </select>
        <label className="block space-y-1 font-medium">
          <span>Post to copy</span>
          <textarea value={post} readOnly rows={4} onFocus={(event) => event.currentTarget.select()}
            className={`block w-full resize-y rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-2 font-normal ${FOCUS_RING}`} />
        </label>
        <button type="button" className={`min-h-11 px-3 font-medium ${CONTROL_BTN} ${FOCUS_RING}`} onClick={async () => {
          const copied = await copyText(post);
          setFeedback(copied ? 'Post copied.' : 'Select the post above and copy it.');
        }}>Copy post</button>
        <span role="status" className="ml-2">{feedback}</span>
        <p className="m-0 text-[var(--ds-muted)]">{nextReleaseStep(view)}</p>
      </div>
    </details>
  );
}

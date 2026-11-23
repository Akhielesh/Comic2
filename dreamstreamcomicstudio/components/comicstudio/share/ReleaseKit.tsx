import React, { useId, useRef, useState } from 'react';
import { type PublicationOwnerView, SLUG_RE } from '../../../shared/comic/publication';
import { CONTROL_BTN, FOCUS_RING } from '../../chat/studioDesign';
import { CHANNEL_LABEL, INTENT_CHANNELS } from './shareModel';
import { hasPrivateFileLink, releasePost, releasePostText, xWeight, X_POST_LIMIT, type ReleaseChannel, type ReleaseGoal } from './releasePosts';
import { copyText } from './useShareCapabilities';

const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['email', ...INTENT_CHANNELS.filter((ch) => ch !== 'email'), 'linkedin'];

function nextReleaseStep(view: PublicationOwnerView): string {
  if (view.behind) return 'Preview the version readers get. Use Update if you want to release your latest edits.';
  const stats = view.stats;
  if (!stats) return 'Copy a post for one channel. Return here after people have had time to read.';
  const opens = Object.values(stats.byChannel7d).reduce((a, b) => a + b, 0);
  if (!opens) return 'No opens were recorded in the last seven days. Pick a channel for your next post.';
  if (!stats.completes7d) return 'Readers have opened the comic. Try reading from the cover to the last page before sharing it again.';
  const ranked = RELEASE_CHANNELS.map((channel) => ({ channel, count: stats.byChannel7d[channel] || 0 }))
    .sort((a, b) => b.count - a.count);
  if (ranked[0].count > ranked[1].count) {
    const { channel, count } = ranked[0];
    return `${CHANNEL_LABEL[channel]} links recorded ${count} ${count === 1 ? 'open' : 'opens'} in seven days, the most of your posting channels. Try it for your next release.`;
  }
  return 'Readers reached the last page. Compare the channel counts below when choosing where to share your next release.';
}

export function ReleaseKit({ view, projectId, ownerId }: { view: PublicationOwnerView; projectId: string; ownerId: string | null }) {
  if (view.status !== 'live' || !view.slug || !SLUG_RE.test(view.slug) || view.visibility === 'private') return null;
  const edition = JSON.stringify([ownerId, projectId, view.slug, view.publishedRev, view.publishedAt, view.defaultLang,
    view.languages, view.rating, view.card?.title, view.card?.description, view.card?.pageCount]);
  return <ReleaseEditor key={edition} view={view} />;
}

const field = `block w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-2 text-[13px] ${FOCUS_RING}`;
const button = `min-h-11 px-3 font-medium ${CONTROL_BTN} ${FOCUS_RING} disabled:opacity-50`;
type Draft = { subject?: string; body?: string };

function ReleaseEditor({ view }: { view: PublicationOwnerView }) {
  const [channel, setChannel] = useState<ReleaseChannel>('email');
  const [goal, setGoal] = useState<ReleaseGoal>('read');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [feedback, setFeedback] = useState('');
  const [manual, setManual] = useState('');
  const copySequence = useRef(0);
  const id = useId();
  const original = releasePost(view, channel, goal);
  if (!original) return null;
  const variant = `${channel}/${goal}`;
  const post = { ...original, ...drafts[variant] };
  const full = releasePostText(post);
  const weight = channel === 'x' ? xWeight(full) : 0;
  const tooLong = weight > X_POST_LIMIT;
  const privateLink = hasPrivateFileLink(post.body) || (channel === 'email' && hasPrivateFileLink(post.subject));

  function clearFeedback() {
    copySequence.current++;
    setFeedback('');
    setManual('');
  }
  function edit(field: keyof Draft, text: string) {
    clearFeedback();
    setDrafts((previous) => ({ ...previous, [variant]: { ...previous[variant], [field]: text } }));
  }
  async function copy(text: string, success: string) {
    const attempt = ++copySequence.current;
    const copied = await copyText(text);
    if (attempt !== copySequence.current) return;
    setFeedback(copied ? success : 'Select and copy the text below.');
    setManual(copied ? '' : text);
  }
  return (
    <details className="rounded-xl border border-[var(--ds-hairline)] px-3 text-[13px] text-[var(--ds-ink)]">
      <summary className={`min-h-11 cursor-pointer content-center font-semibold ${FOCUS_RING}`}>Plan a release post</summary>
      <div className="space-y-3 pb-3">
        <p className="m-0">{view.visibility === 'unlisted' ? 'Anyone receiving this link can pass it on. Your comic stays off the Library shelf.' : 'Your comic is listed in the Library. You can also share its reader link directly.'}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="space-y-1"><span>Where will you share it?</span>
            <select value={channel} onChange={(event) => { clearFeedback(); setChannel(event.target.value as ReleaseChannel); }} className={`${field} min-h-11`}>
              {RELEASE_CHANNELS.map((ch) => <option key={ch} value={ch}>{CHANNEL_LABEL[ch]}</option>)}
            </select>
          </label>
          <label className="space-y-1"><span>Goal</span>
            <select value={goal} onChange={(event) => { clearFeedback(); setGoal(event.target.value as ReleaseGoal); }} className={`${field} min-h-11`}>
              <option value="read">Invite readers</option><option value="feedback">Ask for feedback</option>
            </select>
          </label>
        </div>
        {channel === 'email' && (
          <div>
            <label htmlFor={`${id}-subject`} className="font-medium">Email subject</label>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <input id={`${id}-subject`} value={post.subject} onChange={(event) => edit('subject', event.target.value)} className={`${field} min-h-11 min-w-0 flex-1`} />
              <button type="button" disabled={!post.subject.trim() || privateLink} className={button} onClick={() => void copy(post.subject, 'Subject copied.')}>Copy subject</button>
            </div>
          </div>
        )}
        <label className="block space-y-1"><span className="font-medium">{channel === 'email' ? 'Email body' : 'Post text'}</span>
          <textarea value={post.body} onChange={(event) => edit('body', event.target.value)} rows={5} className={`${field} resize-y`} />
        </label>
        <div className="rounded-lg bg-[var(--ds-well)] p-2 text-[12px]">
          <div className="mb-1 text-[var(--ds-muted)]">Included when you copy</div>
          <div className="whitespace-pre-line break-all" dir="ltr">{post.footer}</div>
        </div>
        {channel === 'x' && <p className="m-0 tabular-nums text-[var(--ds-muted)]">{weight} / {X_POST_LIMIT} weighted characters{tooLong && '. Shorten the post to copy it.'}</p>}
        {privateLink && <p role="alert" className="m-0">Remove the private file link before copying. The reader link is included below your text.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!post.body.trim() || privateLink || tooLong} className={button} onClick={() => void copy(full, channel === 'email' ? 'Email body copied.' : 'Post copied.')}>
            {channel === 'email' ? 'Copy email body' : 'Copy post'}
          </button>
          <span role="status">{feedback}</span>
        </div>
        {manual && <textarea aria-label="Text to copy manually" value={manual} readOnly rows={4} onFocus={(event) => event.currentTarget.select()} className={field} />}
        <p className="m-0 text-[var(--ds-muted)]">{nextReleaseStep(view)}</p>
      </div>
    </details>
  );
}

// QA scene `overflow-stress` (OV-1; SPEC-overflow §7.3; the scene contract is in qa/app/index.tsx): the shared message,
// chip, badge, button, card and pill components with the text that breaks layouts. By default it is an ordinary page
// (short copy) that passes every layout smoke check. With `&stress=1` (what tests/e2e/overflow.spec.ts opens) every block
// gets the three strings from the overflow research: a 300-character error holding a long URL, a 60-character unbroken
// model id and an 80-character file name, plus three stacked error banners and the studio's own boards, pills and
// upload rows. Every row is `flex-wrap`, so a long Button label wraps the row instead of widening the page; long body
// text sits in its own WRAP_TEXT paragraph (the documented SectionCard body pattern). Buttons are the ink `default`
// variant (no spark). Nothing here reaches the network or spends.

import React from 'react';
import { Check } from 'lucide-react';
import { Badge, Button, Chip, EmptyState, ErrorState, Field, Input, MessageText, MetricCard, SectionCard, StatusBanner, StatusChip } from '../../../components/ds';
import { CANVAS_BG, HEADING, INK, MUTED, RADIUS_CONTROL, RADIUS_PANEL, WRAP_TEXT } from '../../../components/chat/studioDesign';
import { cn } from '../../../lib/utils';
import { StudioErrorBanner } from '../../../components/comicstudio/conversation/StudioNotices';
import { ConfirmStrip, RenderOverlay, Chip as BoardChip, EmptyHint } from '../../../components/comicstudio/board/ui';
import { Note } from '../../../components/comicstudio/history/ui';
import { UploadQueue } from '../../../components/comicstudio/refs/UploadQueue';

const LONG_ID = 'google/gemini-3-pro-image-preview-experimental-20261101-a1b2c3';
const LONG_ERROR =
  "We couldn't finish that because the image service answered with an unexpected error. Details: https://api.example-provider.dev/v1/images/generations/very-long-path-segment?model=" +
  LONG_ID +
  '&trace=0123456789abcdef0123456789abcdef failed with code PROVIDER_UPSTREAM_TIMEOUT_EXCEEDED_WHILE_RENDERING after 120 s.';
const LONG_FILE = 'IMG_20261112_0930412345_HDR_portrait_mode_final_final_v3_reference_sheet_maya.png';

/** The scene's copy: ordinary words by default, the research's strings under `?stress=1`. */
interface Copy {
  stress: boolean;
  name: string;
  error: string;
  file: string;
}
const copyFor = (stress: boolean): Copy =>
  stress ? { stress, name: LONG_ID, error: LONG_ERROR, file: LONG_FILE } : { stress, name: 'Nano Banana', error: "That picture wasn't added. Try again.", file: 'maya-reference.png' };
const readStress = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('stress') === '1';
  } catch {
    return false;
  }
};
const noop = () => undefined;

const Block: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
  <section data-testid={`stress-${id}`} aria-labelledby={`stress-${id}-title`} className={cn('min-w-0 border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-4', RADIUS_PANEL)}>
    <h2 id={`stress-${id}-title`} className={cn('m-0 mb-3 text-[length:var(--ds-text-base)] font-semibold', INK)}>
      {title}
    </h2>
    {children}
  </section>
);

/** The shared components (components/ds): measured by default and under stress. */
const SharedBlocks: React.FC<{ c: Copy }> = ({ c }) => (
  <>
    <Block id="error-panel" title="Error panel">
      <ErrorState title={`Couldn't use ${c.name}`} description={c.error} onRetry={noop} />
    </Block>
    <Block id="error-inline" title="Inline error">
      <ErrorState variant="inline" title={`Couldn't use ${c.name}`} description={<MessageText lines={3}>{c.error}</MessageText>} onRetry={noop} />
    </Block>
    <Block id="field" title="Field help and error">
      <Field label={`Model ${c.name}`} description={c.error} error={c.error}>
        <Input defaultValue={c.name} />
      </Field>
    </Block>
    <Block id="labels" title="Chips, badges and buttons">
      <div className="flex flex-wrap gap-2">
        <Chip>{c.name}</Chip>
        <Badge>{c.name}</Badge>
        <Badge variant="secondary">
          <Check aria-hidden="true" /> {c.name}
        </Badge>
        <StatusChip state="error">{c.name}</StatusChip>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button>Use {c.stress ? LONG_ID : 'this style'}</Button>
        <Button variant="outline">Switch</Button>
      </div>
    </Block>
    <Block id="cards" title="Cards">
      <SectionCard title={`Pictures from ${c.name}`} description={c.error}>
        <p className={cn('m-0', WRAP_TEXT, MUTED)}>{c.error}</p>
      </SectionCard>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetricCard title={c.name} value={c.stress ? LONG_ID : '12'} />
        <MetricCard title="Pictures" value="12" />
      </div>
    </Block>
    <Block id="empty" title="Empty state">
      <EmptyState title={`Nothing from ${c.name} yet`} description={c.error} />
    </Block>
    <Block id="messages" title="Long messages">
      <div className="flex flex-col gap-3">
        <StatusBanner tone="healthy" title="Short message">
          <MessageText role="status">Saved a moment ago.</MessageText>
        </StatusBanner>
        <StatusBanner tone="error" title="Long message">
          <MessageText role="status" lines={2}>
            {c.stress ? `${LONG_ERROR} ${LONG_ERROR}` : c.error}
          </MessageText>
        </StatusBanner>
      </div>
    </Block>
  </>
);

/** The studio's own boards, pills and rows: under stress only (they sit inside the studio's touch layout elsewhere). */
const StudioBlocks: React.FC<{ c: Copy }> = ({ c }) => {
  const studioErr = { error: c.error, errorCode: null, clearError: noop, refresh: async () => undefined } as never;
  return (
    <>
      <Block id="stacked-banners" title="Three stacked error banners">
        <div className="flex flex-col gap-2">
          <StudioErrorBanner studio={studioErr} />
          <StudioErrorBanner studio={studioErr} />
          <StudioErrorBanner studio={studioErr} />
        </div>
      </Block>
      <Block id="board-pills" title="Board pills and chips">
        <div className="flex flex-wrap gap-3">
          <BoardChip>{c.name}</BoardChip>
          <div className={cn('relative h-40 w-56 max-w-full overflow-hidden bg-[var(--ds-well)]', RADIUS_CONTROL)}>
            <RenderOverlay status="queued" model={c.name} />
          </div>
          <div className={cn('relative h-56 w-56 max-w-full overflow-hidden bg-[var(--ds-well)]', RADIUS_CONTROL)}>
            <RenderOverlay status="failed" error={c.error} onRetry={noop} />
          </div>
        </div>
      </Block>
      <Block id="board-confirm" title="Confirm strip and empty hint">
        <ConfirmStrip message={c.error} confirmLabel="Delete page" onConfirm={noop} onCancel={noop} />
        <div className="mt-3">
          <EmptyHint title={`No pictures from ${c.name}`}>{c.error}</EmptyHint>
        </div>
      </Block>
      <Block id="history-note" title="History note">
        <Note tone="attention">{c.error}</Note>
      </Block>
      <Block id="upload-queue" title="Upload rows">
        <UploadQueue
          items={
            [
              { id: 'u1', name: c.file, owner: { kind: 'character', id: 'c1' }, state: 'failed', progress: 0, message: c.error, retryable: true },
              { id: 'u2', name: c.file, owner: { kind: 'character', id: 'c1' }, state: 'rejected', progress: 0, message: c.error },
              { id: 'u3', name: c.file, owner: { kind: 'character', id: 'c1' }, state: 'uploading', progress: 0.4 }
            ] as never
          }
          onCancel={noop}
          onRetry={noop}
          onDismiss={noop}
        />
      </Block>
    </>
  );
};

const Scene: React.FC = () => {
  const c = copyFor(readStress());
  return (
    <main className={cn('min-h-dvh px-4 py-6 sm:px-6', CANVAS_BG, INK)}>
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <header>
          <h1 className={cn('m-0', HEADING)}>Long words and messages</h1>
          <p className={cn('m-0 mt-1', WRAP_TEXT, MUTED)}>
            {c.stress ? 'Stress copy: a 300-character error with a URL, a 60-character id and an 80-character file name.' : 'Ordinary copy. Add stress=1 to the address for the long strings.'}
          </p>
        </header>
        <SharedBlocks c={c} />
        {c.stress ? <StudioBlocks c={c} /> : null}
      </div>
    </main>
  );
};

export default { id: 'overflow-stress', title: 'Long words and messages: errors, chips, badges, buttons, cards (OV-1; stress=1 for the long strings)', Scene };

// Admin → Library (assets.md §11, decisions-final #4; owner P1-LIBRARY). Registered through the
// AdminConsole feature registry (library/index.ts); the server re-checks requireAdmin.
//
// The owner's loop: generate the assets, store them, analyze them, refine them.
//   1. Quote (free dry run): per-kind lines, expected and worst case, what is skipped and why.
//   2. Build (one explicit click, after the quote is shown again): creates a run, then THIS console
//      drives it step by step (≤ 3 assets per request). No background job: pausing, closing the
//      tab or a sleeping container is safe — Resume continues where it stopped, nothing is drawn
//      twice, and nothing is spent unless an admin clicked Build or Resume.
//   3. Review: assets at or above the threshold publish themselves; the rest wait here with their
//      candidates side by side, the analysis, and Publish / Reject / Regenerate (with a note).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ImageOff, Images, KeyRound, Loader2, Pause, Play, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import {
  LIBRARY_BUDGET_DEFAULT_USD,
  LIBRARY_BUDGET_MAX_USD,
  LIBRARY_MIN_SCORE,
  type LibraryAssetStatus,
  type LibraryBuildRequest,
  type LibraryEntryView,
  type LibraryKind,
  type LibraryManifestView,
  type LibraryQuote,
  type LibraryRunView,
  type LibraryStepView
} from '../../../../shared/comic/library';
import { getStylePreset } from '../../../../shared/comic/stylePresets';
import { ACCENT_TEXT, OVERLINE, TONE_CHIP, TONE_CHIP_ON_ART, TONE_TEXT } from '../../../chat/studioDesign';
import {
  cancelLibraryRun,
  getLibraryManifest,
  publishLibraryAsset,
  purgeLibraryCandidates,
  quoteLibraryBuild,
  regenerateLibraryAsset,
  rejectLibraryAsset,
  startLibraryBuild,
  stepLibraryRun
} from '../../../../services/adminLibrary';
import { PresetThumb } from '../procedural/PresetThumb';
import { EmptyArt, type EmptyArtVariant } from '../procedural/EmptyArt';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
const usd = (n: number | undefined) => `$${(Math.round((n || 0) * 100) / 100).toFixed(2)}`;
const usd3 = (n: number | undefined) => `$${(n || 0).toFixed(3)}`;
const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.');
const statusOf = (err: unknown) => (typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 0);

const KIND_LABEL: Record<LibraryKind, string> = {
  style_preview: 'Style previews',
  genre_example: 'Genre pages',
  cover_example: 'Covers',
  empty_state: 'Empty states',
  onboarding: 'Onboarding',
  texture_seed: 'Paper textures',
  style_anchor: 'Style anchors (optional)'
};
const KIND_ORDER: LibraryKind[] = ['style_preview', 'genre_example', 'cover_example', 'empty_state', 'onboarding', 'texture_seed', 'style_anchor'];

const STATUS_LABEL: Record<LibraryAssetStatus, string> = {
  pending: 'Queued',
  generating: 'Drawing',
  analyzing: 'Checking',
  needs_review: 'Needs review',
  published: 'Published',
  rejected: 'Rejected',
  failed: 'Failed'
};
const STATUS_CLASS: Record<LibraryAssetStatus, string> = {
  pending: 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]',
  generating: 'bg-[#D97757]/10 text-[var(--ds-accent)]',
  analyzing: 'bg-[#D97757]/10 text-[var(--ds-accent)]',
  needs_review: TONE_CHIP.warning,
  published: TONE_CHIP.success,
  rejected: 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]',
  failed: TONE_CHIP.danger
};
/**
 * The same states as a pill drawn OVER an entry's art: opaque surfaces (TONE_CHIP_ON_ART, the raised
 * surface for the neutral and working states), so the words read on any image — the translucent page
 * chips above vanish over a dark or busy thumbnail.
 */
const STATUS_ON_ART: Record<LibraryAssetStatus, string> = {
  pending: TONE_CHIP_ON_ART.neutral,
  generating: `bg-[var(--ds-raised)] ${ACCENT_TEXT}`,
  analyzing: `bg-[var(--ds-raised)] ${ACCENT_TEXT}`,
  needs_review: TONE_CHIP_ON_ART.warning,
  published: TONE_CHIP_ON_ART.success,
  rejected: TONE_CHIP_ON_ART.neutral,
  failed: TONE_CHIP_ON_ART.danger
};

const btn =
  'inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-xl px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:cursor-not-allowed disabled:opacity-45 coarse:min-h-[44px]';
const primary = `${btn} bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]`;
const ghost = `${btn} border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`;
const panel = 'rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3 sm:p-4';

const emptyVariantFor = (id: string): EmptyArtVariant => {
  if (/studio|onboard/.test(id)) return 'studio';
  if (/cast/.test(id)) return 'cast';
  if (/style|texture/.test(id)) return 'style';
  if (/reader|cover/.test(id)) return 'reader';
  if (/genre|pages/.test(id)) return 'pages';
  return 'media';
};

const EntryArt: React.FC<{ entry: LibraryEntryView; url?: string }> = ({ entry, url }) => {
  const [broken, setBroken] = useState(false);
  const preset = getStylePreset(entry.presetId);
  if (url && !broken) {
    return <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-full w-full object-cover" />;
  }
  if (preset && (entry.kind === 'style_preview' || entry.kind === 'style_anchor')) {
    return (
      <span className="block h-full w-full [&>*]:h-full [&>*]:w-full">
        <PresetThumb preset={preset} />
      </span>
    );
  }
  return (
    <span className="flex h-full w-full items-center justify-center">
      <EmptyArt variant={emptyVariantFor(entry.id)} />
    </span>
  );
};

/** Cancellable wait (the drive loop stops at once on Pause or unmount). */
const wait = (ms: number, stop: { current: boolean }) =>
  new Promise<void>((resolve) => {
    const started = Date.now();
    const tick = () => (stop.current || Date.now() - started >= ms ? resolve() : setTimeout(tick, Math.min(250, ms)));
    tick();
  });

export const LibraryConsole: React.FC = () => {
  const [manifest, setManifest] = useState<LibraryManifestView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [budget, setBudget] = useState(String(LIBRARY_BUDGET_DEFAULT_USD));
  const [includeOptional, setIncludeOptional] = useState(false);
  const [force, setForce] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [quote, setQuote] = useState<LibraryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<LibraryRunView | LibraryStepView | null>(null);
  const [driving, setDriving] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const stop = useRef({ current: false }).current;
  const mounted = useRef(true);
  /** Only the newest drive loop may step or touch state (a stale loop from before a Pause just ends). */
  const driveGen = useRef(0);

  const load = useCallback(async () => {
    try {
      const m = await getLibraryManifest();
      if (!mounted.current) return;
      setManifest(m);
      setLoadError(null);
      setRun((r) => (r && r.status === 'running' && !m.activeRun ? r : m.activeRun ?? (r && r.status !== 'running' ? r : null)));
    } catch (err) {
      if (mounted.current) setLoadError(errText(err));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, [load, stop]);

  const budgetUsd = useMemo(() => {
    const n = Number(budget);
    return Number.isFinite(n) && n > 0 ? Math.min(LIBRARY_BUDGET_MAX_USD, n) : LIBRARY_BUDGET_DEFAULT_USD;
  }, [budget]);

  const request = useCallback(
    (): LibraryBuildRequest => ({
      ...(selected.size ? { ids: [...selected] } : {}),
      ...(includeOptional ? { includeOptional: true } : {}),
      ...(force ? { force: true } : {}),
      budgetUsd
    }),
    [selected, includeOptional, force, budgetUsd]
  );

  const getQuote = useCallback(async () => {
    setQuoting(true);
    setNotice(null);
    try {
      const out = await quoteLibraryBuild(request());
      if (mounted.current) setQuote(out.quote);
      return out.quote;
    } catch (err) {
      if (mounted.current) setNotice({ tone: 'warn', text: errText(err) });
      return null;
    } finally {
      if (mounted.current) setQuoting(false);
    }
  }, [request]);

  // Any change to the selection invalidates the shown quote.
  useEffect(() => {
    setQuote(null);
    setConfirming(false);
  }, [selected, includeOptional, force, budgetUsd]);

  /** Drive a run: one step after another while this console is open and not paused. */
  const drive = useCallback(
    async (runId: string) => {
      const gen = ++driveGen.current;
      const live = () => !stop.current && mounted.current && gen === driveGen.current;
      stop.current = false;
      setPausing(false);
      setDriving(true);
      let failures = 0;
      try {
        while (live()) {
          try {
            const view = await stepLibraryRun(runId, 3);
            if (!mounted.current || gen !== driveGen.current) return;
            failures = 0;
            setRun(view);
            if (view.status !== 'running') {
              setNotice({ tone: view.status === 'completed' ? 'ok' : 'warn', text: view.message });
              break;
            }
            if (view.waitMs > 0) await wait(view.waitMs, stop);
          } catch (err) {
            failures += 1;
            const status = statusOf(err);
            if (!mounted.current || gen !== driveGen.current) return;
            // Bad input, auth, missing key/tables: stop and say why. Network blips: back off and resume.
            if ((status >= 400 && status < 500 && status !== 408 && status !== 429) || status === 503 || failures >= 5) {
              setNotice({ tone: 'warn', text: `${errText(err)} The build is paused; Resume continues where it stopped.` });
              break;
            }
            await wait(Math.min(30_000, 3000 * failures), stop);
          }
        }
      } finally {
        if (mounted.current && gen === driveGen.current) {
          setDriving(false);
          setPausing(false);
          void load();
        }
      }
    },
    [load, stop]
  );

  const build = async () => {
    setStarting(true);
    setNotice(null);
    try {
      const out = await startLibraryBuild(request());
      if (!mounted.current) return;
      setConfirming(false);
      setQuote(out.quote);
      setNotice({ tone: 'ok', text: out.message });
      if (out.run) {
        setRun(out.run);
        setSelected(new Set());
        void drive(out.run.id);
      }
    } catch (err) {
      if (mounted.current) setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    stop.current = true;
    try {
      const view = await cancelLibraryRun(run.id);
      if (mounted.current) {
        setRun(view);
        setNotice({ tone: 'ok', text: 'Build cancelled. Images already drawn are kept; queued ones wait for the next build.' });
      }
    } catch (err) {
      if (mounted.current) setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      void load();
    }
  };

  const assetAction = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyKey(key);
    setNotice(null);
    try {
      const out = await fn();
      if (!mounted.current) return;
      setNotice({ tone: 'ok', text: ok });
      const started = out as { run?: LibraryRunView | null; message?: string } | undefined;
      if (started && 'run' in (started as object) && started.run) {
        setRun(started.run);
        void drive(started.run.id);
      }
      await load();
    } catch (err) {
      if (mounted.current) setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      if (mounted.current) setBusyKey(null);
    }
  };

  const purge = async () => {
    setBusyKey('purge');
    try {
      const dry = await purgeLibraryCandidates(true);
      if (!dry.objects) {
        setNotice({ tone: 'ok', text: 'No unused candidates to purge.' });
        return;
      }
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Delete ${dry.objects} unused candidate files (~${Math.round(dry.bytes / 1024)} KB)? Published and current images are kept.`)) return;
      const done = await purgeLibraryCandidates(false);
      setNotice({ tone: 'ok', text: `Deleted ${done.objects} unused candidate files.` });
      await load();
    } catch (err) {
      setNotice({ tone: 'warn', text: errText(err) });
    } finally {
      if (mounted.current) setBusyKey(null);
    }
  };

  const groups = useMemo(() => {
    const by = new Map<LibraryKind, LibraryEntryView[]>();
    for (const e of manifest?.entries || []) {
      if (e.optional && !includeOptional && !e.row) continue;
      by.set(e.kind, [...(by.get(e.kind) || []), e]);
    }
    return KIND_ORDER.filter((k) => by.has(k)).map((k) => ({ kind: k, entries: by.get(k)! }));
  }, [manifest, includeOptional]);

  const totals = useMemo(() => {
    const rows = (manifest?.entries || []).map((e) => e.row).filter(Boolean);
    const core = (manifest?.entries || []).filter((e) => !e.optional && e.row).map((e) => e.row!);
    return {
      published: core.filter((r) => r.status === 'published' || r.published).length,
      review: rows.filter((r) => r!.status === 'needs_review').length,
      spent: rows.reduce((n, r) => n + (r!.costUsd || 0), 0)
    };
  }, [manifest]);

  const active = run && run.status === 'running' ? run : null;
  const open = openId ? manifest?.entries.find((e) => e.id === openId) : undefined;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!manifest && !loadError) {
    return (
      <div className={cx(panel, 'flex items-center gap-2 text-[13px] text-[var(--ds-muted)]')}>
        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> Loading the library…
      </div>
    );
  }
  if (!manifest) {
    return (
      <div className={cx(panel, 'flex flex-wrap items-center gap-3 text-[13px] text-[var(--ds-ink)]')} role="alert">
        <AlertTriangle className={cx('h-4 w-4 shrink-0', TONE_TEXT.warning)} aria-hidden />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{loadError}</span>
        <button type="button" className={ghost} onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
        </button>
      </div>
    );
  }

  const progress = active ? Math.round((active.counts.done / Math.max(1, active.counts.total)) * 100) : 0;

  return (
    <div className="min-w-0 space-y-3 text-[var(--ds-ink)]">
      {/* Header: what this is, key/table status, totals. */}
      <section className={panel} aria-label="Library status">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <Images className="h-4 w-4 text-[var(--ds-accent)]" aria-hidden /> Platform asset library
            </h2>
            <p className="mt-1 max-w-prose text-[12.5px] leading-snug text-[var(--ds-muted)]">
              Style previews, genre pages, covers and empty-state art, generated fresh from descriptions (never from anyone's images), checked by
              software and a vision pass, refined, and published automatically at a score of {LIBRARY_MIN_SCORE.toFixed(2)} or better. The rest wait
              here for review.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11.5px]">
            <span className="rounded-full bg-[var(--ds-well-strong)] px-2 py-1 tabular-nums">v{manifest.manifestVersion}</span>
            <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-1', manifest.platformKey ? STATUS_CLASS.published : STATUS_CLASS.failed)}>
              <KeyRound className="h-3 w-3" aria-hidden /> {manifest.platformKey ? 'Platform key ready' : 'No platform image key'}
            </span>
            {!manifest.tableReady && <span className={cx('rounded-full px-2 py-1', STATUS_CLASS.needs_review)}>Tables not installed</span>}
          </div>
        </div>
        {/* Three columns while a cell fits its longest one-word label ("Published" as an overline, 5.75rem cells: from
            about 350 px); on the narrowest phones two, the third below. Labels wrap at spaces, never cut off,
            and the values line up along the bottom of each row. */}
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(5.75rem,1fr))] gap-2 text-center" data-library-stats="">
          {[
            ['Published', `${totals.published}/${manifest.entries.filter((e) => !e.optional).length}`],
            ['Needs review', String(totals.review)],
            ['Spent (all builds)', usd(totals.spent)]
          ].map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col rounded-xl bg-[var(--ds-well)] px-2 py-2">
              <dt className={cx('mb-0.5 break-words', OVERLINE)}>{k}</dt>
              <dd className="mt-auto text-[16px] font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {!manifest.tableReady && (
          <p className="mt-3 text-[12.5px] text-[var(--ds-muted)]">
            Apply <code className="rounded bg-[var(--ds-well-strong)] px-1">server/sql/comic_library.sql</code> to the database, then reload. Quotes work already.
          </p>
        )}
      </section>

      {notice && (
        <div
          role="status"
          className={cx(
            'flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] [overflow-wrap:anywhere]',
            notice.tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/35 bg-amber-500/10'
          )}
        >
          {notice.tone === 'ok' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0 rounded-md p-1 hover:bg-[var(--ds-hover)]">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}

      {/* Active run: progress, spend, pause/resume/cancel. */}
      {active && (
        <section className={panel} aria-label="Build in progress">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 text-[13px] font-semibold">
              {pausing ? 'Pausing after this step…' : driving ? 'Building…' : 'Build paused'}{' '}
              <span className="font-normal tabular-nums text-[var(--ds-muted)]">
                {active.counts.done}/{active.counts.total} · {usd(active.spentUsd)} of {usd(active.budgetUsd)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {driving ? (
                <button
                  type="button"
                  className={ghost}
                  disabled={pausing}
                  onClick={() => {
                    stop.current = true;
                    setPausing(true);
                  }}
                >
                  <Pause className="h-3.5 w-3.5" aria-hidden /> {pausing ? 'Pausing…' : 'Pause'}
                </button>
              ) : (
                <button type="button" className={primary} onClick={() => void drive(active.id)} disabled={!manifest.platformKey}>
                  <Play className="h-3.5 w-3.5" aria-hidden /> Resume
                </button>
              )}
              <button type="button" className={ghost} onClick={() => void cancel()}>
                <X className="h-3.5 w-3.5" aria-hidden /> Cancel build
              </button>
            </div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--ds-well-strong)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Build progress">
            <div className="h-full rounded-full bg-[var(--ds-accent)] motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-[12px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
            {(active as Partial<LibraryStepView>).message || 'Each step draws up to 3 images.'} Keep this tab open while it builds; pausing is safe.
          </p>
        </section>
      )}

      {/* Quote + build controls. */}
      <section className={panel} aria-label="Build the library">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[120px] flex-col gap-1 text-[12px] text-[var(--ds-muted)]">
            Budget for this build (USD)
            <input
              type="number"
              inputMode="decimal"
              min={0.5}
              max={LIBRARY_BUDGET_MAX_USD}
              step={0.5}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="h-9 w-28 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 text-[13px] tabular-nums text-[var(--ds-ink)] coarse:h-11"
            />
          </label>
          <label className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={includeOptional} onChange={(e) => setIncludeOptional(e.target.checked)} className="h-4 w-4 accent-[#D97757]" />
            Include optional style anchors
          </label>
          <label className="flex min-h-[36px] items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="h-4 w-4 accent-[#D97757]" />
            Force rebuild {selected.size ? 'selected' : 'everything'}
          </label>
        </div>
        <p className="mt-2 text-[12px] text-[var(--ds-muted)]">
          {selected.size ? `${selected.size} selected below.` : 'Nothing selected: the whole manifest is considered.'} Hard maximum {usd(LIBRARY_BUDGET_MAX_USD)} per build.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={ghost} onClick={() => void getQuote()} disabled={quoting}>
            {quoting ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />} Get a quote (free)
          </button>
          <button
            type="button"
            className={primary}
            disabled={!!active || !manifest.platformKey || !manifest.tableReady || quoting}
            onClick={async () => {
              const q = quote ?? (await getQuote());
              if (q) setConfirming(true);
            }}
          >
            <Images className="h-3.5 w-3.5" aria-hidden /> Build library…
          </button>
          {selected.size > 0 && (
            <button type="button" className={ghost} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          )}
          <button type="button" className={ghost} onClick={() => void purge()} disabled={!!active || busyKey === 'purge'}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Purge unused candidates
          </button>
        </div>

        {quote && (
          <div className="mt-3 rounded-xl bg-[var(--ds-well)] p-3 text-[12.5px]">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                {quote.images} image{quote.images === 1 ? '' : 's'} · about {usd(quote.usd)}
              </span>
              <span className="tabular-nums text-[var(--ds-muted)]">
                at most {usd(Math.min(quote.worstCaseUsd, budgetUsd))} with refines (worst case {usd(quote.worstCaseUsd)}, budget {usd(budgetUsd)})
              </span>
            </div>
            {quote.lines.length > 0 && (
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {quote.lines.map((l) => (
                  <li key={l.kind} className="flex justify-between gap-2 tabular-nums">
                    <span className="truncate">{KIND_LABEL[l.kind]} × {l.count}</span>
                    <span>{usd3(l.usd)}</span>
                  </li>
                ))}
              </ul>
            )}
            {quote.skipped.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[var(--ds-muted)]">
                  {quote.skipped.length} skipped <ChevronDown className="inline h-3 w-3" aria-hidden />
                </summary>
                <ul className="mt-1 space-y-0.5 text-[var(--ds-muted)]">
                  {quote.skipped.slice(0, 60).map((s) => (
                    <li key={s.id} className="[overflow-wrap:anywhere]">
                      <span className="font-mono text-[11px]">{s.id}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="mt-2 text-[11.5px] text-[var(--ds-muted)]">This quote is free: nothing is generated until you confirm a build.</p>
          </div>
        )}

        {confirming && quote && (
          <div role="dialog" aria-label="Confirm the build" className="mt-3 rounded-xl border border-[#D97757]/40 bg-[#D97757]/5 p-3">
            <p className="text-[13px] font-semibold">
              Draw {quote.images} image{quote.images === 1 ? '' : 's'} for about {usd(quote.usd)}?
            </p>
            <p className="mt-1 text-[12px] text-[var(--ds-muted)]">
              Refines may add up to {usd(Math.max(0, Math.min(quote.worstCaseUsd, budgetUsd) - quote.usd))}; the build stops before it would pass {usd(budgetUsd)}. Platform spend, logged in
              Costs.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={primary} onClick={() => void build()} disabled={starting || quote.images === 0}>
                {starting ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />} Build {quote.images}
              </button>
              <button type="button" className={ghost} onClick={() => setConfirming(false)}>
                Not now
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Asset grid by kind. */}
      {groups.map(({ kind, entries }) => (
        <section key={kind} className={panel} aria-label={KIND_LABEL[kind]}>
          <h3 className="mb-2 flex items-center justify-between gap-2 text-[13px] font-semibold">
            <span className="truncate">{KIND_LABEL[kind]}</span>
            <span className="shrink-0 text-[11.5px] font-normal tabular-nums text-[var(--ds-muted)]">
              {entries.filter((e) => e.row?.published).length}/{entries.length} live
            </span>
          </h3>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {entries.map((e) => {
              const row = e.row;
              const status: LibraryAssetStatus = row?.status ?? 'pending';
              const isSel = selected.has(e.id);
              return (
                <li key={e.id} className={cx('min-w-0 overflow-hidden rounded-xl border bg-[var(--ds-surface-strong)]', openId === e.id ? 'border-[#D97757]/55' : 'border-[var(--ds-hairline)]')}>
                  <button type="button" onClick={() => setOpenId(openId === e.id ? null : e.id)} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#D97757]/45" aria-expanded={openId === e.id}>
                    <span className="relative block aspect-[4/3] w-full overflow-hidden bg-[var(--ds-well)] text-[var(--ds-muted)]">
                      <EntryArt entry={e} url={row?.thumb || row?.published?.thumb} />
                      <span data-status-pill="" className={cx('absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold', STATUS_ON_ART[status])}>
                        {row ? STATUS_LABEL[status] : 'Not built'}
                      </span>
                      {row && !row.upToDate && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-[var(--ds-surface-strong)] px-1.5 py-0.5 text-[10px]">Prompt changed</span>}
                    </span>
                    <span className="block px-2 py-1.5">
                      <span className="block truncate font-mono text-[11px]">{e.id}</span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] tabular-nums text-[var(--ds-muted)]">
                        {typeof row?.score === 'number' && <span>score {row.score.toFixed(2)}</span>}
                        {row && <span>{row.attempts} try</span>}
                        {row && row.costUsd > 0 && <span>{usd3(row.costUsd)}</span>}
                        {!row && <span>≈{usd3(e.estimateUsd)}</span>}
                      </span>
                      {row?.issues?.[0] && status !== 'published' && <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-snug text-[var(--ds-muted)]">{row.error || row.issues[0]}</span>}
                    </span>
                  </button>
                  <label className="flex min-h-[32px] cursor-pointer items-center gap-1.5 border-t border-[var(--ds-hairline-soft)] px-2 text-[11px] text-[var(--ds-muted)] coarse:min-h-[44px]">
                    <input type="checkbox" checked={isSel} onChange={() => toggle(e.id)} aria-label={`Select ${e.id}`} className="h-3.5 w-3.5 accent-[#D97757]" /> Select
                  </label>
                </li>
              );
            })}
          </ul>
          {open && open.kind === kind && <AssetDrawer entry={open} busyKey={busyKey} note={note} setNote={setNote} onClose={() => setOpenId(null)} act={assetAction} running={!!active} />}
        </section>
      ))}
    </div>
  );
};

const AssetDrawer: React.FC<{
  entry: LibraryEntryView;
  busyKey: string | null;
  note: string;
  setNote: (s: string) => void;
  onClose: () => void;
  running: boolean;
  act: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}> = ({ entry, busyKey, note, setNote, onClose, act, running }) => {
  const row = entry.row;
  const busy = (k: string) => busyKey === `${k}:${entry.id}`;
  // Publish/reject only wait for THIS asset's in-flight attempt while a build runs (a row left
  // mid-attempt by a cancelled build is the server's call: it answers 409 until no step can hold it);
  // regenerate waits for the running build (one run at a time).
  const drawing = running && (row?.status === 'generating' || row?.status === 'analyzing');
  return (
    <div role="region" className="mt-3 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3" aria-label={`${entry.id} details`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[12px] font-semibold">{entry.id}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
            {entry.model} · {entry.resolution} · {entry.aspect} · {entry.theme} · ≈{usd3(entry.estimateUsd)} per try
          </p>
          <p className="mt-1 text-[12px] [overflow-wrap:anywhere]">{entry.alt}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="shrink-0 rounded-lg p-1.5 hover:bg-[var(--ds-hover)]">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {!row?.candidates.length ? (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-[var(--ds-muted)]">
          <ImageOff className="h-4 w-4" aria-hidden /> {row?.error || 'No images yet. Select it and build, or regenerate it below.'}
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {row.candidates.map((c) => {
            const live = row.published?.rev === c.rev;
            return (
              <li key={c.rev} className={cx('min-w-0 overflow-hidden rounded-lg border bg-[var(--ds-surface-strong)]', live ? 'border-emerald-500/50' : 'border-[var(--ds-hairline)]')}>
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="block aspect-[4/3] overflow-hidden bg-[var(--ds-well)]">
                  <img src={c.thumb || c.url} alt={c.alt || `Candidate ${c.rev}`} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                </a>
                <div className="space-y-1 p-2 text-[11px]">
                  <div className="flex flex-wrap items-center justify-between gap-1 tabular-nums">
                    <span className="font-semibold">
                      rev {c.rev} · {c.score.toFixed(2)}
                    </span>
                    <span className="text-[var(--ds-muted)]">{c.strategy}</span>
                  </div>
                  {live && <span className={cx('inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold', STATUS_CLASS.published)}>Live</span>}
                  {live && (
                    <button
                      type="button"
                      className={cx(ghost, 'mt-1 w-full')}
                      disabled={drawing || busy('takedown')}
                      onClick={() => {
                        // eslint-disable-next-line no-alert
                        if (!window.confirm(`Take ${entry.id} down? Every screen falls back to its free procedural art until another image is published.`)) return;
                        void act(`takedown:${entry.id}`, () => rejectLibraryAsset(entry.id, note.trim() || undefined, { unpublish: true }), `Took ${entry.id} down.`).then(() => setNote(''));
                      }}
                    >
                      {busy('takedown') ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <ImageOff className="h-3.5 w-3.5" aria-hidden />} Take down
                    </button>
                  )}
                  {!c.current && <span className="block text-[10px] text-[var(--ds-muted)]">Older prompt</span>}
                  {c.issues.slice(0, 3).map((i, k) => (
                    <p key={`${k}:${i}`} className="leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">
                      {i}
                    </p>
                  ))}
                  {c.textFound?.length ? <p className="text-[var(--ds-muted)] [overflow-wrap:anywhere]">Text seen: {c.textFound.join(' · ')}</p> : null}
                  {c.palette?.length ? (
                    <div className="flex gap-1" aria-label="Palette">
                      {c.palette.slice(0, 5).map((p) => (
                        <span key={p} className="h-3 w-3 rounded-full border border-[var(--ds-hairline)]" style={{ background: p }} title={p} />
                      ))}
                    </div>
                  ) : null}
                  {!live && (
                    <button
                      type="button"
                      className={cx(ghost, 'mt-1 w-full')}
                      disabled={drawing || busy('publish')}
                      onClick={() => void act(`publish:${entry.id}`, () => publishLibraryAsset(entry.id, c.rev), `Published ${entry.id} (rev ${c.rev}).`)}
                    >
                      {busy('publish') ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />} Publish this
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 space-y-2">
        <label className="block text-[12px] text-[var(--ds-muted)]">
          Art-director note (optional, for Regenerate or Reject)
          <textarea
            value={note}
            maxLength={300}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. warmer lamp light, the dog a little bigger"
            className="mt-1 block w-full resize-y rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2 py-1.5 text-[13px] text-[var(--ds-ink)]"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primary}
            disabled={running || busy('regenerate')}
            onClick={() => {
              // eslint-disable-next-line no-alert
              if (!window.confirm(`Regenerate ${entry.id}? About ${usd3(entry.estimateUsd)} per try, up to 3 tries.`)) return;
              void act(`regenerate:${entry.id}`, () => regenerateLibraryAsset(entry.id, note.trim() ? { note: note.trim() } : {}), `Regenerating ${entry.id}.`).then(() => setNote(''));
            }}
          >
            {busy('regenerate') ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Regenerate
          </button>
          {row && row.status !== 'rejected' && (
            <button
              type="button"
              className={ghost}
              disabled={drawing || busy('reject')}
              onClick={() => void act(`reject:${entry.id}`, () => rejectLibraryAsset(entry.id, note.trim() || undefined), `Rejected ${entry.id}.`).then(() => setNote(''))}
            >
              {busy('reject') ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />} Reject
            </button>
          )}
        </div>
        {running && <p className="text-[11.5px] text-[var(--ds-muted)]">Regenerate unlocks when the current build finishes or is cancelled (one build at a time).</p>}
      </div>
    </div>
  );
};

export default LibraryConsole;

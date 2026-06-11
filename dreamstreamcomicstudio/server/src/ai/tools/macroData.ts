// Macro & calendar widget tools — UI ships complete TODAY; live data lights up
// per-tool when the matching env key is configured (see
// docs/features/data-connectors.md for the research/signup guide):
//
//  - show_macro_tiles       FRED_API_KEY          → live CPI/UNRATE/GDP… series
//  - get_econ_calendar      FINNHUB_API_KEY       → live economic releases (tier-dependent)
//  - get_earnings_calendar  FINNHUB_API_KEY       → live earnings dates/estimates
//  - get_national_debt      (keyless)             → Treasury FiscalData, live now
//  - render_central_banks   model-authored        → no free implied-path source yet
//  - render_pnl_calendar    model/user-authored
//
// Every tool degrades honestly: without a key it renders the model-supplied
// data and returns a capability notice naming the env var that upgrades it.

import type { ChatTool } from './types.js';
import type {
  MacroTilesArtifact,
  MacroTile,
  EconCalendarArtifact,
  EconEvent,
  EarningsCalendarArtifact,
  EarningsItem,
  EarningsSession,
  CentralBankWatchArtifact,
  CentralBank,
  PnlCalendarArtifact,
  PnlDay,
  DebtClockArtifact
} from '../../../../apiTypes.js';
import { fetchJson, envKey } from './http.js';

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ macro tiles ---

const FRED_OBS = 'https://api.stlouisfed.org/fred/series/observations';

/** Latest + previous + sparkline for one FRED series. Best-effort per tile. */
const fredFill = async (seriesId: string, key: string, signal?: AbortSignal): Promise<Partial<MacroTile> | null> => {
  try {
    const url = `${FRED_OBS}?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=14`;
    const data = await fetchJson<{ observations?: { date: string; value: string }[] }>(url, { signal });
    const obs = (data.observations ?? [])
      .map((o) => ({ date: o.date, value: num(o.value) }))
      .filter((o): o is { date: string; value: number } => o.value !== undefined);
    const latest = obs[0];
    if (!latest) return null;
    const prev = obs[1];
    return {
      value: latest.value,
      delta: prev ? Number((latest.value - prev.value).toFixed(3)) : undefined,
      spark: obs.map((o) => o.value).reverse(),
      asOf: latest.date,
      source: 'FRED'
    };
  } catch {
    return null;
  }
};

const coerceTiles = (v: unknown): MacroTile[] =>
  (Array.isArray(v) ? v : [])
    .flatMap((t): MacroTile[] => {
      if (!t || typeof t !== 'object') return [];
      const r = t as Record<string, unknown>;
      const label = str(r.label, 60);
      if (!label) return [];
      return [
        {
          label,
          seriesId: str(r.seriesId, 40),
          value: typeof r.value === 'number' ? r.value : str(r.value, 24),
          unit: str(r.unit, 12),
          delta: num(r.delta),
          deltaPercent: num(r.deltaPercent),
          spark: Array.isArray(r.spark) ? (r.spark as unknown[]).map(Number).filter(Number.isFinite).slice(-24) : undefined,
          nextRelease: str(r.nextRelease, 24),
          source: str(r.source, 40),
          asOf: str(r.asOf, 24)
        }
      ];
    })
    .slice(0, 12);

export const macroTilesTool: ChatTool = {
  name: 'show_macro_tiles',
  description:
    'Show a wall of MACRO INDICATOR tiles (CPI, unemployment, GDP, Fed funds, PMI…) — value, change, sparkline and next-release countdown per tile. Use for "how is the economy doing", inflation/jobs/rates questions, or a macro dashboard. Provide the tiles; when you know the FRED series id include it as `seriesId` (CPIAUCSL, UNRATE, FEDFUNDS, GDP, T10Y2Y, MORTGAGE30US, PAYEMS…) — with a configured FRED key the server replaces your values with the live series, so the seriesId matters more than your numbers.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      tiles: {
        type: 'array',
        description: '3–9 indicators.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'e.g. "CPI (YoY)".' },
            seriesId: { type: 'string', description: 'FRED series id for live fill, e.g. "CPIAUCSL".' },
            value: { type: 'string', description: 'Your best known value (overridden by live data when keyed).' },
            unit: { type: 'string', description: 'e.g. "%", "K jobs".' },
            delta: { type: 'number' },
            nextRelease: { type: 'string', description: 'ISO date of the next scheduled release, when known.' },
            source: { type: 'string' }
          },
          required: ['label']
        }
      }
    },
    required: ['tiles']
  },
  execute: async (args, signal) => {
    const tiles = coerceTiles(args?.tiles);
    if (!tiles.length) return { content: 'No usable macro tiles were provided (each needs a label).' };
    const key = envKey('FRED_API_KEY');
    let liveCount = 0;
    if (key) {
      await Promise.all(
        tiles.map(async (t) => {
          if (!t.seriesId) return;
          const fill = await fredFill(t.seriesId, key, signal);
          if (fill) {
            Object.assign(t, fill);
            liveCount++;
          }
        })
      );
    }
    const data: MacroTilesArtifact = {
      title: str(args?.title, 80),
      tiles,
      live: liveCount > 0,
      asOf: new Date().toISOString()
    };
    return {
      content: `Rendered the macro tile wall (${tiles.length} indicators${liveCount ? `, ${liveCount} filled live from FRED` : ', model-supplied values'}). Add one short macro read, not a restatement.`,
      artifacts: [{ type: 'macro_tiles', data }],
      ...(key
        ? {}
        : {
            notice: {
              level: 'info' as const,
              message: 'Macro tiles are showing model-supplied values — live FRED series need a key.',
              fix: 'Set FRED_API_KEY (free: fred.stlouisfed.org)'
            }
          })
    };
  }
};

// ------------------------------------------------------------- economic calendar ---

const FINNHUB = 'https://finnhub.io/api/v1';

const IMPACT_MAP: Record<string, 1 | 2 | 3> = { low: 1, medium: 2, high: 3 };

const coerceEvents = (v: unknown): EconEvent[] =>
  (Array.isArray(v) ? v : [])
    .flatMap((e): EconEvent[] => {
      if (!e || typeof e !== 'object') return [];
      const r = e as Record<string, unknown>;
      const time = str(r.time, 32);
      const title = str(r.title, 140);
      if (!time || !title) return [];
      const imp = num(r.importance);
      return [
        {
          time,
          title,
          country: str(r.country, 8),
          importance: imp === 1 || imp === 2 || imp === 3 ? imp : undefined,
          actual: typeof r.actual === 'number' ? r.actual : str(r.actual, 20),
          forecast: typeof r.forecast === 'number' ? r.forecast : str(r.forecast, 20),
          previous: typeof r.previous === 'number' ? r.previous : str(r.previous, 20),
          unit: str(r.unit, 12)
        }
      ];
    })
    .slice(0, 40);

export const econCalendarTool: ChatTool = {
  name: 'get_econ_calendar',
  description:
    'Show the ECONOMIC CALENDAR as a timeline — upcoming releases (CPI, NFP, FOMC, GDP…) with importance dots and, for past events, actual-vs-forecast beat/miss coloring. Use for "what economic data is out this week", pre-FOMC context, or macro planning. With a configured Finnhub key the events come live; otherwise PROVIDE the events yourself from what you know (and say they are model-recalled).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      days: { type: 'number', description: 'Days ahead to cover when fetching live (default 7, max 31). Live mode also includes the past 2 days.' },
      events: {
        type: 'array',
        description: 'The events (used as-is when live data is unavailable).',
        items: {
          type: 'object',
          properties: {
            time: { type: 'string', description: 'ISO datetime of the release.' },
            title: { type: 'string' },
            country: { type: 'string' },
            importance: { type: 'number', description: '1 low · 2 medium · 3 high.' },
            actual: { type: 'string' },
            forecast: { type: 'string' },
            previous: { type: 'string' },
            unit: { type: 'string' }
          },
          required: ['time', 'title']
        }
      }
    }
  },
  execute: async (args, signal) => {
    const key = envKey('FINNHUB_API_KEY');
    let events = coerceEvents(args?.events);
    let live = false;
    let liveError: string | undefined;
    if (key) {
      try {
        const days = Math.max(1, Math.min(31, num(args?.days) ?? 7));
        const from = isoDay(new Date(Date.now() - 2 * 86_400_000));
        const to = isoDay(new Date(Date.now() + days * 86_400_000));
        const data = await fetchJson<{ economicCalendar?: Record<string, unknown>[] }>(
          `${FINNHUB}/calendar/economic?from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
          { signal }
        );
        const fetched = (data.economicCalendar ?? [])
          .flatMap((r): EconEvent[] => {
            const time = str(r.time, 32);
            const title = str(r.event, 140);
            if (!time || !title) return [];
            return [
              {
                // Finnhub uses "YYYY-MM-DD HH:mm:ss" — normalize to ISO.
                time: time.replace(' ', 'T'),
                title,
                country: str(r.country, 8),
                importance: IMPACT_MAP[String(r.impact ?? '').toLowerCase()],
                actual: num(r.actual),
                forecast: num(r.estimate),
                previous: num(r.prev),
                unit: str(r.unit, 12)
              }
            ];
          })
          .slice(0, 40);
        if (fetched.length) {
          events = fetched;
          live = true;
        }
      } catch (err) {
        liveError = (err as Error)?.message || 'unknown error';
      }
    }
    if (!events.length) {
      return {
        content: key
          ? `The live economic calendar returned nothing${liveError ? ` (${liveError} — this endpoint may not be in your Finnhub tier)` : ''} and no fallback events were provided. Provide the events you know in the \`events\` argument.`
          : 'No events were provided. Either provide events you know, or configure FINNHUB_API_KEY for live data.',
        notice: { level: 'warn' as const, message: 'No economic-calendar events to display.', fix: key ? undefined : 'Set FINNHUB_API_KEY (free: finnhub.io)' }
      };
    }
    const data: EconCalendarArtifact = { title: str(args?.title, 80), events, live, asOf: new Date().toISOString() };
    return {
      content: `Rendered the economic calendar (${events.length} events, ${live ? 'live from Finnhub' : 'model-supplied'}). Point out the highest-impact upcoming release; do not list everything.`,
      artifacts: [{ type: 'econ_calendar', data }],
      ...(live
        ? {}
        : {
            notice: {
              level: 'info' as const,
              message: liveError
                ? `Live calendar fetch failed (${liveError}) — showing model-supplied events.`
                : 'Economic calendar is model-supplied — live releases need a key.',
              fix: key ? 'Verify your Finnhub tier includes /calendar/economic (see docs/features/data-connectors.md §4-B)' : 'Set FINNHUB_API_KEY (free: finnhub.io)'
            }
          })
    };
  }
};

// ------------------------------------------------------------- earnings calendar ---

const SESSION_MAP: Record<string, EarningsSession> = { bmo: 'pre', amc: 'after', dmh: 'during' };

const coerceEarnings = (v: unknown): EarningsItem[] =>
  (Array.isArray(v) ? v : [])
    .flatMap((e): EarningsItem[] => {
      if (!e || typeof e !== 'object') return [];
      const r = e as Record<string, unknown>;
      const symbol = str(r.symbol, 12)?.toUpperCase();
      const date = str(r.date, 24);
      if (!symbol || !date) return [];
      const session = str(r.session, 12) as EarningsSession | undefined;
      return [
        {
          symbol,
          name: str(r.name, 80),
          date,
          session: session && ['pre', 'after', 'during', 'unknown'].includes(session) ? session : undefined,
          epsEstimate: num(r.epsEstimate),
          epsActual: num(r.epsActual),
          revenueEstimate: num(r.revenueEstimate),
          impliedMovePct: num(r.impliedMovePct),
          preview: str(r.preview, 160)
        }
      ];
    })
    .slice(0, 20);

export const earningsCalendarTool: ChatTool = {
  name: 'get_earnings_calendar',
  description:
    'Show UPCOMING EARNINGS as a countdown carousel — report date, before/after the bell, EPS estimate, implied move and your one-line preview per company. Use for "who reports this week", earnings-season planning, or watching a specific name into the print. With a configured Finnhub key the dates/estimates come live (optionally filtered to `symbols`); add `impliedMovePct` and `preview` yourself — they are your analysis, clearly labeled.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      days: { type: 'number', description: 'Days ahead when fetching live (default 7, max 31).' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'Optional watchlist filter for live mode.' },
      items: {
        type: 'array',
        description: 'The earnings entries (used as-is when live data is unavailable; merged for preview/impliedMove otherwise).',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            name: { type: 'string' },
            date: { type: 'string', description: 'ISO report date.' },
            session: { type: 'string', enum: ['pre', 'after', 'during', 'unknown'] },
            epsEstimate: { type: 'number' },
            epsActual: { type: 'number' },
            impliedMovePct: { type: 'number', description: 'Your estimated post-earnings move, %.' },
            preview: { type: 'string', description: 'Your one-line preview.' }
          },
          required: ['symbol', 'date']
        }
      }
    }
  },
  execute: async (args, signal) => {
    const key = envKey('FINNHUB_API_KEY');
    const provided = coerceEarnings(args?.items);
    let items = provided;
    let live = false;
    let liveError: string | undefined;
    if (key) {
      try {
        const days = Math.max(1, Math.min(31, num(args?.days) ?? 7));
        const from = isoDay(new Date(Date.now() - 86_400_000));
        const to = isoDay(new Date(Date.now() + days * 86_400_000));
        const data = await fetchJson<{ earningsCalendar?: Record<string, unknown>[] }>(
          `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
          { signal }
        );
        const wanted = new Set(
          (Array.isArray(args?.symbols) ? (args.symbols as unknown[]) : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
        );
        // Carry the model's analysis (preview, implied move) onto the live rows.
        const enrich = new Map(provided.map((p) => [p.symbol, p]));
        const fetched = (data.earningsCalendar ?? [])
          .flatMap((r): EarningsItem[] => {
            const symbol = str(r.symbol, 12)?.toUpperCase();
            const date = str(r.date, 24);
            if (!symbol || !date) return [];
            if (wanted.size && !wanted.has(symbol)) return [];
            const extra = enrich.get(symbol);
            return [
              {
                symbol,
                name: extra?.name,
                date,
                session: SESSION_MAP[String(r.hour ?? '').toLowerCase()] ?? 'unknown',
                epsEstimate: num(r.epsEstimate),
                epsActual: num(r.epsActual),
                revenueEstimate: num(r.revenueEstimate),
                impliedMovePct: extra?.impliedMovePct,
                preview: extra?.preview
              }
            ];
          })
          .slice(0, 20);
        if (fetched.length) {
          items = fetched;
          live = true;
        }
      } catch (err) {
        liveError = (err as Error)?.message || 'unknown error';
      }
    }
    if (!items.length) {
      return {
        content: key
          ? `No earnings found in the window${liveError ? ` (live fetch failed: ${liveError})` : ''} and no fallback items were provided.`
          : 'No earnings entries were provided. Either provide them, or configure FINNHUB_API_KEY for live dates.',
        notice: { level: 'warn' as const, message: 'No earnings to display.', fix: key ? undefined : 'Set FINNHUB_API_KEY (free: finnhub.io)' }
      };
    }
    const data: EarningsCalendarArtifact = { title: str(args?.title, 80), items, live, asOf: new Date().toISOString() };
    return {
      content: `Rendered the earnings countdown (${items.length} reports, ${live ? 'live dates from Finnhub' : 'model-supplied'}). Call out the report that matters most to the user.`,
      artifacts: [{ type: 'earnings_calendar', data }],
      ...(live
        ? {}
        : {
            notice: {
              level: 'info' as const,
              message: liveError ? `Live earnings fetch failed (${liveError}) — showing model-supplied dates.` : 'Earnings dates are model-supplied — live data needs a key.',
              fix: key ? undefined : 'Set FINNHUB_API_KEY (free: finnhub.io)'
            }
          })
    };
  }
};

// ---------------------------------------------------------------- national debt ---

const FISCAL_DATA =
  'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=2';

export const nationalDebtTool: ChatTool = {
  name: 'get_national_debt',
  description:
    'Get the LIVE US national debt (Treasury "Debt to the Penny", keyless) rendered as a running odometer that ticks per second from the recent drift. Use when the user asks about the national debt, deficits in dollar terms, or wants the debt-clock widget.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    try {
      const data = await fetchJson<{ data?: { record_date: string; tot_pub_debt_out_amt: string }[] }>(FISCAL_DATA, { signal });
      const rows = data.data ?? [];
      const latest = rows[0];
      const amount = num(latest?.tot_pub_debt_out_amt);
      if (!latest || amount === undefined) throw new Error('feed returned no usable rows');
      const prev = rows[1];
      const prevAmount = num(prev?.tot_pub_debt_out_amt);
      let perSecond: number | undefined;
      if (prev && prevAmount !== undefined) {
        const seconds = (new Date(latest.record_date).getTime() - new Date(prev.record_date).getTime()) / 1000;
        if (seconds > 0) perSecond = (amount - prevAmount) / seconds;
      }
      const artifact: DebtClockArtifact = {
        label: 'US national debt',
        amount,
        asOf: latest.record_date,
        perSecond,
        previous: prev && prevAmount !== undefined ? { date: prev.record_date, amount: prevAmount } : undefined,
        source: 'US Treasury · Debt to the Penny'
      };
      const trillions = (amount / 1e12).toFixed(2);
      return {
        content: `US national debt: $${trillions}T as of ${latest.record_date}${perSecond ? ` (drifting ~$${Math.round(perSecond).toLocaleString()}/second)` : ''}. A live odometer card is shown — one line of context (per-capita, vs GDP) beats restating the number.`,
        artifacts: [{ type: 'debt_clock', data: artifact }],
        citations: [{ url: 'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/', title: 'Treasury FiscalData — Debt to the Penny' }]
      };
    } catch (err) {
      return {
        content: `Could not fetch the live national debt (${(err as Error)?.message || 'unknown error'}). No card was shown — do NOT recite a remembered figure as current.`,
        notice: { level: 'error' as const, message: 'Treasury FiscalData is unreachable right now.' }
      };
    }
  }
};

// ------------------------------------------------------------- central bank watch ---

export const centralBanksTool: ChatTool = {
  name: 'render_central_banks',
  description:
    'Render a CENTRAL BANK WATCH board — one card per bank (Fed, ECB, BoJ, BoE, RBI…) with the current policy rate, days to the next meeting, the market-implied rate path (your assessment, labeled), the last change and a one-line read of recent communication. Use for rate-decision questions, "when does the Fed meet", or monetary-policy context. Provide accurate data from what you know; use web_search first when freshness matters.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      banks: {
        type: 'array',
        description: '1–6 banks.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            code: { type: 'string', description: 'Short chip label, e.g. "Fed".' },
            rateName: { type: 'string', description: 'e.g. "Fed funds target (upper)".' },
            ratePct: { type: 'number' },
            nextMeeting: { type: 'string', description: 'ISO date.' },
            impliedPath: {
              type: 'array',
              items: { type: 'object', properties: { label: { type: 'string' }, ratePct: { type: 'number' } }, required: ['label', 'ratePct'] }
            },
            lastChange: { type: 'string', description: 'e.g. "+25 bps · Mar 2026".' },
            summary: { type: 'string', description: 'One-liner on the latest bank communication.' }
          },
          required: ['name', 'ratePct']
        }
      }
    },
    required: ['banks']
  },
  execute: async (args) => {
    const banks: CentralBank[] = (Array.isArray(args?.banks) ? args.banks : [])
      .flatMap((b): CentralBank[] => {
        if (!b || typeof b !== 'object') return [];
        const r = b as Record<string, unknown>;
        const name = str(r.name, 60);
        const ratePct = num(r.ratePct);
        if (!name || ratePct === undefined) return [];
        const impliedPath = (Array.isArray(r.impliedPath) ? r.impliedPath : [])
          .flatMap((p) => {
            const pr = p as Record<string, unknown>;
            const label = str(pr.label, 20);
            const rate = num(pr.ratePct);
            return label && rate !== undefined ? [{ label, ratePct: rate }] : [];
          })
          .slice(0, 8);
        return [
          {
            name,
            code: str(r.code, 8),
            rateName: str(r.rateName, 60),
            ratePct,
            nextMeeting: str(r.nextMeeting, 24),
            impliedPath: impliedPath.length ? impliedPath : undefined,
            lastChange: str(r.lastChange, 60),
            summary: str(r.summary, 200)
          }
        ];
      })
      .slice(0, 6);
    if (!banks.length) return { content: 'No usable central banks were provided (each needs a name and ratePct).' };
    const data: CentralBankWatchArtifact = { title: str(args?.title, 80), banks, asOf: new Date().toISOString() };
    return {
      content: `Rendered the central bank watch (${banks.map((b) => `${b.code ?? b.name} ${b.ratePct}%`).join(', ')}). The card carries the detail — add only what changed recently.`,
      artifacts: [{ type: 'central_bank_watch', data }]
    };
  }
};

// ---------------------------------------------------------------- P&L calendar ---

export const pnlCalendarTool: ChatTool = {
  name: 'render_pnl_calendar',
  description:
    'Render a GitHub-style CALENDAR HEATMAP of daily values — trading P&L, savings, workout minutes, words written: any signed daily series. Green/red intensity by value, with total, win-rate and best/worst footer. Use when the user shares or asks to visualize day-by-day performance.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      currency: { type: 'string', description: 'ISO code when values are money.' },
      unit: { type: 'string', description: 'Unit when not money, e.g. "%", "min".' },
      days: {
        type: 'array',
        description: 'Daily values (up to ~200; gaps are fine).',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'ISO date.' },
            value: { type: 'number' },
            note: { type: 'string' }
          },
          required: ['date', 'value']
        }
      }
    },
    required: ['days']
  },
  execute: async (args) => {
    const days: PnlDay[] = (Array.isArray(args?.days) ? args.days : [])
      .flatMap((d): PnlDay[] => {
        if (!d || typeof d !== 'object') return [];
        const r = d as Record<string, unknown>;
        const date = str(r.date, 24);
        const value = num(r.value);
        if (!date || value === undefined || Number.isNaN(new Date(date).getTime())) return [];
        return [{ date, value, note: str(r.note, 120) }];
      })
      .slice(0, 220);
    if (!days.length) return { content: 'No usable daily values were provided (each needs an ISO date and a numeric value).' };
    const data: PnlCalendarArtifact = {
      title: str(args?.title, 80),
      currency: str(args?.currency, 8),
      unit: str(args?.unit, 12),
      days
    };
    const total = days.reduce((s, d) => s + d.value, 0);
    const green = days.filter((d) => d.value > 0).length;
    return {
      content: `Rendered the calendar heatmap: ${days.length} days, total ${total >= 0 ? '+' : ''}${total.toFixed(2)}, ${green} positive. One insight (streaks, best week) beats restating the totals.`,
      artifacts: [{ type: 'pnl_calendar', data }]
    };
  }
};

export const MACRO_WIDGET_TOOLS: ChatTool[] = [
  macroTilesTool,
  econCalendarTool,
  earningsCalendarTool,
  nationalDebtTool,
  centralBanksTool,
  pnlCalendarTool
];

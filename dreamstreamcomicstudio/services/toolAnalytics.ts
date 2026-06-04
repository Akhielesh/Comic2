// Client-side usage analytics for the live tools.
//
// Every chat/swarm response reports which tools ran (ChatToolEvent[]). We fold those
// into a small per-tool tally in localStorage so the Settings → Tools dashboard can
// show *real* usage — call counts, success rate, last used and recent queries —
// rather than invented numbers. Strictly local; nothing is sent anywhere.

import type { ChatToolEvent } from '../apiTypes';

export interface ToolStat {
  /** Total times the model invoked this tool. */
  calls: number;
  /** Successful invocations (tool returned without error). */
  ok: number;
  /** Failed invocations. */
  fail: number;
  /** Epoch ms of the most recent call. */
  lastUsedAt: number;
  /** A few recent query strings (for context in the dashboard). */
  recentQueries: string[];
}

export type ToolStats = Record<string, ToolStat>;

const STORAGE = 'dreamstream_tool_analytics';
export const TOOL_ANALYTICS_CHANGED = 'dreamstream:tool-analytics-changed';
const MAX_RECENT = 5;

const read = (): ToolStats => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE);
    const parsed = raw ? (JSON.parse(raw) as ToolStats) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const write = (stats: ToolStats): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(stats));
    window.dispatchEvent(new CustomEvent(TOOL_ANALYTICS_CHANGED));
  } catch {
    /* ignore quota / serialization errors */
  }
};

const blank = (): ToolStat => ({ calls: 0, ok: 0, fail: 0, lastUsedAt: 0, recentQueries: [] });

/** Fold a batch of tool events (from one response) into the running tallies. */
export const recordToolEvents = (events: ChatToolEvent[] | undefined): void => {
  if (!events || !events.length) return;
  const stats = read();
  const now = Date.now();
  for (const ev of events) {
    if (!ev?.tool) continue;
    const s = stats[ev.tool] || blank();
    s.calls += 1;
    if (ev.ok) s.ok += 1;
    else s.fail += 1;
    s.lastUsedAt = now;
    const q = (ev.query || '').trim();
    if (q) s.recentQueries = [q, ...s.recentQueries.filter((x) => x !== q)].slice(0, MAX_RECENT);
    stats[ev.tool] = s;
  }
  write(stats);
};

export const getToolStats = (): ToolStats => read();
export const getToolStat = (name: string): ToolStat | undefined => read()[name];

export interface AnalyticsSummary {
  totalCalls: number;
  totalOk: number;
  totalFail: number;
  successRate: number; // 0..1, 1 when no calls yet
  distinctToolsUsed: number;
  topTools: { name: string; calls: number }[];
}

export const summarizeToolStats = (stats: ToolStats = read()): AnalyticsSummary => {
  const entries = Object.entries(stats);
  let totalCalls = 0;
  let totalOk = 0;
  let totalFail = 0;
  for (const [, s] of entries) {
    totalCalls += s.calls;
    totalOk += s.ok;
    totalFail += s.fail;
  }
  const topTools = entries
    .map(([name, s]) => ({ name, calls: s.calls }))
    .filter((t) => t.calls > 0)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);
  return {
    totalCalls,
    totalOk,
    totalFail,
    successRate: totalCalls ? totalOk / totalCalls : 1,
    distinctToolsUsed: entries.filter(([, s]) => s.calls > 0).length,
    topTools
  };
};

export const resetToolStats = (): void => write({});

export const onToolAnalyticsChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const h = () => handler();
  window.addEventListener(TOOL_ANALYTICS_CHANGED, h);
  return () => window.removeEventListener(TOOL_ANALYTICS_CHANGED, h);
};

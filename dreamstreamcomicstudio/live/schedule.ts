/** Event scheduling helpers: countdown formatting and add-to-calendar (.ics). */

/** "in 2d 4h" / "in 1h 12m" / "in 3m" / "any moment now" for a future timestamp. */
export function formatCountdown(msUntil: number): string {
  if (msUntil <= 30_000) return 'any moment now';
  const totalMin = Math.round(msUntil / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

const icsDate = (ms: number): string =>
  new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Minimal RFC 5545 calendar entry for the event. */
export function buildIcs(opts: { title: string; startMs: number; durationMin?: number; url: string }): string {
  const uid = `${opts.startMs}-${opts.url.replace(/\W/g, '').slice(-24)}@dreamstream`;
  const end = opts.startMs + (opts.durationMin ?? 60) * 60_000;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DreamStream//Live//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(opts.startMs)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${esc(opts.title)}`,
    `DESCRIPTION:Watch live: ${esc(opts.url)}`,
    `URL:${opts.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

export function downloadIcs(opts: { title: string; startMs: number; url: string }): void {
  const blob = new Blob([buildIcs(opts)], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dreamstream-live.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

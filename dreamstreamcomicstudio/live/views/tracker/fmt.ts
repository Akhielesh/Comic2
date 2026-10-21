// Labels, units and one-line descriptions for tracker entries.
import type { TrackData, TrackItem, TrackKind } from '../../monitor/trackTypes';

export const KIND_META: Record<TrackKind, { label: string; icon: string; tone: string; timed?: boolean }> = {
  breast: { label: 'Breastfeed', icon: 'breast', tone: 'rose', timed: true },
  bottle: { label: 'Bottle', icon: 'bottle', tone: 'rose' },
  solids: { label: 'Solids', icon: 'spoon', tone: 'amber' },
  pump: { label: 'Pump', icon: 'pump', tone: 'violet', timed: true },
  diaper: { label: 'Diaper', icon: 'diaper', tone: 'teal' },
  sleep: { label: 'Sleep', icon: 'moon', tone: 'indigo', timed: true },
  growth: { label: 'Growth', icon: 'ruler', tone: 'green' },
  med: { label: 'Medicine', icon: 'pill', tone: 'red' },
  temp: { label: 'Temperature', icon: 'thermo', tone: 'red' },
  activity: { label: 'Activity', icon: 'smile', tone: 'amber', timed: true },
  note: { label: 'Note', icon: 'edit', tone: 'neutral' },
};

export const ACTIVITY_LABEL: Record<NonNullable<TrackData['type']>, string> = {
  tummy: 'Tummy time', bath: 'Bath', play: 'Play', outdoor: 'Outside', reading: 'Reading', skin: 'Skin-to-skin',
  teeth: 'Brushing teeth', screen: 'Screen time', other: 'Other',
};

export const QUALITY_LABEL: Record<1 | 2 | 3 | 4 | 5, string> = { 1: 'Restless', 2: 'Fussy', 3: 'OK', 4: 'Good', 5: 'Great' };

/* ------------------------------------------------------------- units */

export type VolUnit = 'ml' | 'oz';
export type TempUnit = 'c' | 'f';
const ML_PER_OZ = 29.5735;

const read = <T extends string>(k: string, allowed: T[], dflt: T): T => {
  try {
    const v = localStorage.getItem(k) as T | null;
    return v && allowed.includes(v) ? v : dflt;
  } catch {
    return dflt;
  }
};
/** US English → oz / °F by default; everyone else ml / °C. */
const usLocale = () => typeof navigator !== 'undefined' && /^en-US/i.test(navigator.language || '');
export const loadVolUnit = (): VolUnit => read('ds-track-vol', ['ml', 'oz'], usLocale() ? 'oz' : 'ml');
export const loadTempUnit = (): TempUnit => read('ds-track-temp', ['c', 'f'], usLocale() ? 'f' : 'c');
export const saveUnit = (k: 'vol' | 'temp', v: string) => {
  try {
    localStorage.setItem(`ds-track-${k}`, v);
  } catch { /* storage unavailable */ }
};

export const toOz = (ml: number) => ml / ML_PER_OZ;
export const fromOz = (oz: number) => oz * ML_PER_OZ;
export const fmtVol = (ml: number | undefined, u: VolUnit) =>
  ml == null ? '' : u === 'oz' ? `${Math.round(toOz(ml) * 10) / 10} oz` : `${Math.round(ml)} ml`;
export const cToF = (c: number) => (c * 9) / 5 + 32;
export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const fmtTemp = (c: number | undefined, u: TempUnit) => (c == null ? '' : u === 'f' ? `${(Math.round(cToF(c) * 10) / 10).toFixed(1)} °F` : `${c.toFixed(1)} °C`);

/* ------------------------------------------------------------- time */

export const fmtDur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
};

export const fmtClock = (t: number, tz?: string) => {
  try {
    return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz });
  } catch {
    return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
};

export const fmtAgo = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60 ? `${m % 60} m ` : ''}ago` : `${Math.floor(h / 24)} d ago`;
};

/** ms offset of a time zone at `t` (local − UTC). */
function tzOffset(t: number, tz?: string): number {
  if (!tz) return -new Date(t).getTimezoneOffset() * 60_000;
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  } catch {
    return -new Date(t).getTimezoneOffset() * 60_000;
  }
}

/** Local midnight (in the nursery's time zone) of the day containing `t`. */
export function dayStart(t: number, tz?: string): number {
  const off = tzOffset(t, tz);
  const local = t + off;
  const mid = local - (((local % 86_400_000) + 86_400_000) % 86_400_000);
  // Re-check the offset at midnight (DST changes happen at night).
  return mid - tzOffset(mid - off, tz);
}

export const addDays = (start: number, n: number, tz?: string) => dayStart(start + n * 86_400_000 + 3 * 3_600_000, tz);

export const fmtDay = (t: number, now: number, tz?: string) => {
  const today = dayStart(now, tz);
  const d = dayStart(t, tz);
  if (d === today) return 'Today';
  if (d === addDays(today, -1, tz)) return 'Yesterday';
  try {
    return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  } catch {
    return new Date(t).toLocaleDateString();
  }
};

/** For <input type="datetime-local"> in the device's own zone. */
export const toLocalInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => new Date(v).getTime();

/* ------------------------------------------------------------ describe */

export function describe(i: TrackItem, u: { vol: VolUnit; temp: TempUnit }, now = Date.now()): string {
  const d = i.data;
  const running = i.end == null;
  const span = (running ? now : i.end!) - i.start;
  switch (i.kind) {
    case 'breast': {
      const side = (secs?: number) => (!secs ? '0' : secs < 60 ? '<1' : String(Math.round(secs / 60)));
      return `${running ? 'Breastfeeding' : 'Breastfed'} ${fmtDur(span)}${d.left || d.right ? ` · L ${side(d.left)} · R ${side(d.right)}` : d.side ? ` · ${d.side}` : ''}`;
    }
    case 'bottle':
      return `Bottle · ${fmtVol(d.ml, u.vol)}${d.milk === 'breast' ? ' breast milk' : d.milk === 'formula' ? ' formula' : d.milk === 'mixed' ? ' mixed' : ''}`;
    case 'solids':
      return `Solids${d.foods ? ` · ${d.foods}` : ''}${d.amount ? ` · ate ${d.amount === 'taste' ? 'a taste' : d.amount}` : ''}${d.reaction ? ` · ${d.reaction}` : ''}`;
    case 'pump': {
      const tot = (d.mlLeft ?? 0) + (d.mlRight ?? 0);
      return running ? `Pumping ${fmtDur(span)}` : `Pumped ${fmtVol(tot, u.vol)}${d.mlLeft && d.mlRight ? ` (L ${fmtVol(d.mlLeft, u.vol)} · R ${fmtVol(d.mlRight, u.vol)})` : ''} · ${fmtDur(span)}`;
    }
    case 'diaper': {
      const what = d.pee && d.poo ? 'Wet + dirty' : d.poo ? 'Dirty' : d.pee ? 'Wet' : 'Dry';
      return `${what} diaper${d.load && d.load !== 'medium' ? ` · ${d.load}` : ''}${d.color ? ` · ${d.color}` : ''}${d.texture ? ` · ${d.texture}` : ''}${d.rash ? ' · rash' : ''}`;
    }
    case 'sleep':
      return running
        ? `Asleep ${fmtDur(span)}`
        : `${i.src === 'monitor' ? 'Slept (camera)' : d.night === true ? 'Night sleep' : d.night === false ? 'Nap' : 'Slept'} ${fmtDur(span)}${d.where ? ` · ${d.where}` : ''}${d.wakings ? ` · ${d.wakings} waking${d.wakings > 1 ? 's' : ''}` : ''}${d.quality ? ` · ${QUALITY_LABEL[d.quality].toLowerCase()}` : ''}`;
    case 'growth':
      return [d.kg != null && (u.vol === 'oz' ? `${Math.floor(d.kg * 2.20462)} lb ${Math.round(((d.kg * 2.20462) % 1) * 16)} oz` : `${d.kg} kg`), d.cm != null && (u.vol === 'oz' ? `${(d.cm / 2.54).toFixed(1)} in` : `${d.cm} cm`), d.headCm != null && `head ${u.vol === 'oz' ? `${(d.headCm / 2.54).toFixed(1)} in` : `${d.headCm} cm`}`]
        .filter(Boolean)
        .join(' · ');
    case 'med':
      return d.skipped
        ? `Skipped · ${d.name ?? 'Medicine'}`
        : `${d.name ?? 'Medicine'}${d.dose != null ? ` · ${d.dose} ${d.unit ?? ''}`.trimEnd() : ''}${d.everyH ? ` · every ${d.everyH} h` : ''}`;
    case 'temp':
      return `${fmtTemp(d.c, u.temp)}${d.method ? ` · ${d.method}` : ''}`;
    case 'activity':
      return `${d.type ? ACTIVITY_LABEL[d.type] : 'Activity'} ${fmtDur(span)}${running ? ' so far' : ''}`;
    case 'note':
      return d.note ?? 'Note';
  }
}

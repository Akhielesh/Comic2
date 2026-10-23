// Settings → Usage, and each nursery's Usage section — a calm monthly card (ADR 0007 D4;
// feature doc §4.5, Phase B6). Comic Studio's monthly allowance view, translated: what was
// FREE (and why: your devices, your Wi-Fi, your Google Drive) next to what went THROUGH OUR
// SERVERS, with fair-use meters, at most one tip, and "What this costs DreamStream (est.)"
// folded away.
//
// It loads ONCE, when it opens, over sockets that are already open (usage/usageClient.ts).
// No timers, no polling: come back to see newer numbers.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { emptyCounters, FAIR_USE, monthKey, type UsageCounters, type UsageKind } from '@/shared/stream/usage';
import { fmtGb as fmtGiB, type CloudCopyQuota } from '../../cloudCopy';
import {
  TIPS,
  USAGE,
  allowanceLevel,
  cloudCopyNotice,
  fmtDuration,
  fmtGb,
  nightReceiptText,
  pctOf,
  relayNotice,
  type AllowanceLevel,
} from '../../costCopy';
import { listMyEvents } from '../../events';
import { fmtBytes } from '../../metrics';
import { Icon } from '../../ui/icons';
import { Meter, cx } from '../../ui/primitives';
import { CostExpander } from '../../usage/CostExpander';
import { deviceMonth, nightSummary } from '../../usage/ledger';
import {
  fetchAccountCloudQuota,
  relayDataOf,
  requestAccountUsage,
  requestNurseryUsage,
  type AccountUsage,
  type NurseryUsage,
  type QueryLike,
} from '../../usage/usageClient';

const MIN = 60_000;

/* ---------------------------------------------------------------- pieces */

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="usage-row">
      <span className="usage-row-label">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span className="usage-row-value mono">{value}</span>
    </div>
  );
}

const TONE: Record<AllowanceLevel, string> = { ok: 'accent', warn: 'amber', full: 'live' };

function Allowance({ label, used, limit, value, sub, notice }: { label: string; used: number; limit: number; value: string; sub?: string; notice?: string | null }) {
  const pct = pctOf(used, limit);
  const level = allowanceLevel(used, limit);
  return (
    <div className={cx('usage-row usage-allow', `is-${level}`)}>
      <span className="usage-row-label">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span className="usage-row-value mono">
        {value} <span className="usage-pct">{pct}%</span>
      </span>
      <div className="usage-meter" aria-label={`${label}: ${pct}% of the allowance`}>
        <Meter value={Math.min(100, pct)} tone={TONE[level]} height={5} />
      </div>
      {notice && (
        <p className="usage-notice" role="status">
          <Icon name={level === 'full' ? 'alert' : 'info'} size={13} />
          {notice}
        </p>
      )}
    </div>
  );
}

function Head({ month }: { month: string }) {
  return (
    <div className="usage-head">
      <b>{USAGE.title(month)}</b>
      <span className="faint">{USAGE.resets(month)}</span>
    </div>
  );
}

function Group({ title, tone, children }: { title: string; tone: 'free' | 'servers'; children: React.ReactNode }) {
  return (
    <div className={cx('usage-group', `usage-${tone}`)}>
      <div className="usage-group-title">
        <Icon name={tone === 'free' ? 'check' : 'globe'} size={13} />
        {title}
      </div>
      {children}
    </div>
  );
}

const Tip = ({ text }: { text: string | null }) =>
  text ? (
    <p className="usage-tip">
      <Icon name="sparkles" size={13} />
      <span>{text}</span>
    </p>
  ) : null;

const minutesMs = (c: UsageCounters | undefined, p: keyof UsageCounters['minutes']) => (c ? c.minutes[p] * MIN : 0);

/* ------------------------------------------------------- Settings → Usage */

/** This device's broadcasts that went live this month (the dashboard keeps them up to date). */
function broadcastsThisMonth(now: number): { count: number; ms: number } {
  const month = monthKey(now);
  let count = 0;
  let ms = 0;
  for (const e of listMyEvents()) {
    if (!e.startedAt || monthKey(e.startedAt) !== month) continue;
    count += 1;
    ms += Math.max(0, (e.endedAt ?? now) - e.startedAt);
  }
  return { count, ms };
}

export function AccountUsageCard({ signedIn, now: nowProp }: { signedIn: boolean; now?: number }) {
  // One moment for the whole card: it's a snapshot, refreshed by opening it again.
  const [now] = useState(() => nowProp ?? Date.now());
  // undefined = asking; null = couldn't tell.
  const [acct, setAcct] = useState<AccountUsage | null | undefined>(signedIn ? undefined : null);
  const [quota, setQuota] = useState<CloudCopyQuota | null | undefined>(signedIn ? undefined : null);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    void requestAccountUsage().then((r) => alive && setAcct(r));
    void fetchAccountCloudQuota().then((q) => alive && setQuota(q));
    return () => {
      alive = false;
    };
  }, [signedIn]);

  const month = acct?.usage.month ?? monthKey(now);
  const dev = useMemo(() => deviceMonth(monthKey(now)), [now]);
  const casts = useMemo(() => broadcastsThisMonth(now), [now]);
  const call = acct?.usage.counters.call;
  const callFree = minutesMs(call, 'lan') + minutesMs(call, 'direct');
  const callRelay = minutesMs(call, 'turn');
  const monFree = dev.monitor.lan + dev.monitor.direct;
  const monPaid = dev.monitor.turn + dev.monitor.server;
  const relay = acct ? relayDataOf(acct.usage, 'call') : null;
  const relayLimit = (acct?.allowances.relayDataGb ?? FAIR_USE.relayDataGbPerAccountMonth) * 1e9;
  const cloudUsed = quota?.usedBytes ?? 0;

  const free: React.ReactNode[] = [];
  if (callFree > 0) free.push(<Row key="calls" label="Calls you placed" sub="Home Wi-Fi and direct · counted per person on the call" value={fmtDuration(callFree)} />);
  if (monFree > 0) {
    free.push(<Row key="mon" label="Baby monitor on this device" sub={`Home Wi-Fi ${fmtDuration(dev.monitor.lan)} · Direct ${fmtDuration(dev.monitor.direct)}`} value={fmtDuration(monFree)} />);
  }
  if (dev.saves.drive > 0) free.push(<Row key="drive" label="Saved to Google Drive" sub={`${USAGE.drive} · saved from ${USAGE.thisDevice}`} value={fmtBytes(dev.saves.drive)} />);
  if (dev.saves.device > 0) free.push(<Row key="device" label="Saved to this device" sub={USAGE.device} value={fmtBytes(dev.saves.device)} />);

  const anyServers = (relay?.bytes ?? 0) > 0 || callRelay > 0 || cloudUsed > 0 || dev.saves.cloud > 0 || monPaid > 0 || casts.count > 0;
  const relayLevel = relay ? allowanceLevel(relay.bytes, relayLimit) : 'ok';
  const cloudLevel = quota ? allowanceLevel(quota.usedBytes, quota.limitBytes) : 'ok';

  const byKind: Partial<Record<UsageKind, UsageCounters>> = { ...(acct?.usage.counters ?? {}) };
  if (cloudUsed > 0) byKind.cloud_copy = { ...emptyCounters(), cloudCopyBytes: cloudUsed };

  const tip =
    cloudUsed > 0 || dev.saves.cloud > 0 ? TIPS.drive : callRelay > 0 ? TIPS.callsWifi : monPaid > 0 ? TIPS.sameWifi : null;

  return (
    <section className="usage-card" aria-label="Usage this month">
      <Head month={month} />
      {!signedIn && <p className="usage-note">{USAGE.signedOut}</p>}
      {signedIn && acct === undefined && <p className="usage-note" role="status">{USAGE.loading}</p>}
      {signedIn && acct === null && <p className="usage-note">{USAGE.offline}</p>}

      <Group title={USAGE.freeHead} tone="free">
        {free.length ? free : <p className="usage-none">{USAGE.nothingYet}</p>}
      </Group>

      <Group title={USAGE.serversHead} tone="servers">
        {!anyServers && <p className="usage-empty">{USAGE.empty}</p>}
        {relay && (
          <Allowance
            label="Relay data · calls you placed"
            used={relay.bytes}
            limit={relayLimit}
            value={`${relay.measured ? '' : '≈ '}${fmtGb(relay.bytes)} of ${fmtGb(relayLimit)}`}
            sub={callRelay > 0 ? `${fmtDuration(callRelay)} of calls through our relay${relay.measured ? '' : ` · ${USAGE.estimated}`}` : USAGE.relayNoCount}
            notice={relayNotice(relayLevel, relay.bytes, relayLimit / 1e9, month, 'account')}
          />
        )}
        {quota && (
          <Allowance
            label="7-day cloud copies"
            used={quota.usedBytes}
            limit={quota.limitBytes}
            value={`${fmtGiB(quota.usedBytes)} of ${Math.round(quota.limitBytes / 1024 ** 3)} GB`}
            sub={`${quota.copies} cop${quota.copies === 1 ? 'y' : 'ies'} · each kept 7 days`}
            notice={cloudCopyNotice(cloudLevel, quota.usedBytes, quota.limitBytes)}
          />
        )}
        {!quota && dev.saves.cloud > 0 && <Row label="7-day cloud copies" sub={`saved from ${USAGE.thisDevice}`} value={fmtBytes(dev.saves.cloud)} />}
        {monPaid > 0 && (
          <Row
            label="Baby monitor on this device"
            sub={[dev.monitor.turn > 0 && `relay ${fmtDuration(dev.monitor.turn)}`, dev.monitor.server > 0 && `our server ${fmtDuration(dev.monitor.server)}`].filter(Boolean).join(' · ')}
            value={fmtDuration(monPaid)}
          />
        )}
        {casts.count > 0 && <Row label="Broadcasts" sub={`${casts.count} live stream${casts.count === 1 ? '' : 's'} from ${USAGE.thisDevice} · free for you`} value={fmtDuration(casts.ms)} />}
      </Group>

      {acct && <CostExpander byKind={byKind} />}
      <Tip text={tip} />
      <p className="usage-foot faint">{USAGE.accountNote}</p>
    </section>
  );
}

/* ----------------------------------------------------- a nursery (parents) */

export function NurseryUsageCard({ query, nid, now: nowProp, showNight = true }: { query: QueryLike | null; nid: string; now?: number; showNight?: boolean }) {
  const [now] = useState(() => nowProp ?? Date.now());
  const [data, setData] = useState<NurseryUsage | 'forbidden' | null | undefined>(undefined);
  // One read when it opens. A reconnect (a new query channel) asks again only if that failed.
  const loaded = useRef(false);
  useEffect(() => {
    if (!query || loaded.current) return;
    let alive = true;
    setData(undefined);
    void requestNurseryUsage(query, nid).then((r) => {
      if (!alive) return;
      if (r) loaded.current = true;
      setData(r);
    });
    return () => {
      alive = false;
    };
  }, [query, nid]);
  const night = useMemo(() => nightSummary(nid, now), [nid, now]);
  if (data === 'forbidden') return <p className="usage-note">{USAGE.parentsOnly}</p>;

  const usage = data ? data.usage : null;
  const month = usage?.month ?? monthKey(now);
  const mon = usage?.counters.monitor;
  const lan = minutesMs(mon, 'lan');
  const direct = minutesMs(mon, 'direct');
  const turn = minutesMs(mon, 'turn');
  const server = minutesMs(mon, 'server');
  const relay = usage ? relayDataOf(usage, 'monitor') : null;
  const relayLimit = (data ? data.allowances.relayDataGb : FAIR_USE.relayDataGbPerNurseryMonth) * 1e9;
  const relayLevel = relay ? allowanceLevel(relay.bytes, relayLimit) : 'ok';
  const nightPaid = night ? night.ms.turn + night.ms.server : 0;
  const tip = nightPaid > 30 * MIN ? TIPS.relayNight(fmtDuration(nightPaid)) : turn + server > 0 ? TIPS.sameWifi : null;

  return (
    <section className="usage-card usage-nursery" aria-label="This nursery’s usage this month">
      <Head month={month} />
      {showNight && <NightLine night={night} />}
      {data === undefined && query && <p className="usage-note" role="status">{USAGE.loading}</p>}
      {(data === null || !query) && <p className="usage-note">{USAGE.offline}</p>}
      {usage && (
        <>
          <Group title={USAGE.freeHead} tone="free">
            {lan + direct > 0 ? (
              <>
                {lan > 0 && <Row label="Home Wi-Fi" sub={USAGE.homeWifi} value={fmtDuration(lan)} />}
                {direct > 0 && <Row label="Direct" sub={USAGE.direct} value={fmtDuration(direct)} />}
              </>
            ) : (
              <p className="usage-none">{USAGE.nothingReported}</p>
            )}
          </Group>
          <Group title={USAGE.serversHead} tone="servers">
            {!(turn + server > 0) && !(relay && relay.bytes > 0) && <p className="usage-empty">{USAGE.empty}</p>}
            {relay && (
              <Allowance
                label="Relay data · this nursery’s viewers"
                used={relay.bytes}
                limit={relayLimit}
                value={`${relay.measured ? '' : '≈ '}${fmtGb(relay.bytes)} of ${fmtGb(relayLimit)}`}
                sub={turn > 0 ? `${fmtDuration(turn)} through our relay${relay.measured ? '' : ` · ${USAGE.estimated}`}` : USAGE.relayNoCount}
                notice={relayNotice(relayLevel, relay.bytes, relayLimit / 1e9, month, 'nursery')}
              />
            )}
            {server > 0 && <Row label="Picture through our server" sub={USAGE.serverPicture} value={fmtDuration(server)} />}
          </Group>
          <CostExpander byKind={mon ? { monitor: mon } : {}} />
          <Tip text={tip} />
          <p className="usage-foot faint">{USAGE.nurseryNote}</p>
        </>
      )}
    </section>
  );
}

function NightLine({ night }: { night: ReturnType<typeof nightSummary> }) {
  if (!night) return null;
  return (
    <p className="usage-night">
      <Icon name="moon" size={13} />
      {nightReceiptText(night.label, night.ms)} <span className="faint">· {USAGE.thisDevice}</span>
    </p>
  );
}

/**
 * Nursery settings → Usage (parents): last night's receipt from this device straight away
 * (no request), and the nursery's month folded away — read once when it's opened.
 */
export function NurseryUsage({ query, nid }: { query: QueryLike | null; nid: string }) {
  const [open, setOpen] = useState(false);
  const night = useMemo(() => nightSummary(nid), [nid]);
  return (
    <div className="ns-usage">
      <NightLine night={night} />
      <details className="usage-open" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>{USAGE.openNursery}</summary>
        {open && <NurseryUsageCard query={query} nid={nid} showNight={false} />}
      </details>
    </div>
  );
}

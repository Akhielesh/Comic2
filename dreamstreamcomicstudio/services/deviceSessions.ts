import { supabase } from './supabase';

const DEVICE_ID_KEY = 'dreamstream_device_id';

export interface UserDevice {
  id: string;
  device_id: string;
  device_name: string;
  user_agent: string | null;
  last_seen: string;
  created_at: string;
}

/** Get (or generate) a stable device ID for this browser. */
export const getDeviceId = (): string => {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
};

/** Derive a short friendly name from the user-agent string. */
export const parseDeviceName = (ua: string): string => {
  const s = ua.toLowerCase();

  // OS detection
  let os = 'Unknown OS';
  if (s.includes('iphone')) os = 'iPhone';
  else if (s.includes('ipad')) os = 'iPad';
  else if (s.includes('android')) os = 'Android';
  else if (s.includes('mac os')) os = 'Mac';
  else if (s.includes('windows')) os = 'Windows';
  else if (s.includes('linux')) os = 'Linux';

  // Browser detection
  let browser = 'Browser';
  if (s.includes('edg/')) browser = 'Edge';
  else if (s.includes('opr/') || s.includes('opera')) browser = 'Opera';
  else if (s.includes('chrome')) browser = 'Chrome';
  else if (s.includes('firefox')) browser = 'Firefox';
  else if (s.includes('safari')) browser = 'Safari';

  return `${os} · ${browser}`;
};

/** Upsert this device into the user_devices table on login. */
export const registerDevice = async (userId: string): Promise<void> => {
  try {
    const deviceId = getDeviceId();
    const ua = navigator.userAgent;
    const name = parseDeviceName(ua);

    await supabase.from('user_devices').upsert(
      {
        user_id: userId,
        device_id: deviceId,
        device_name: name,
        user_agent: ua,
        last_seen: new Date().toISOString(),
      },
      { onConflict: 'user_id,device_id' }
    );

    // Self-heal: the browser-stored device_id regenerates (cleared storage, private
    // mode, …), leaving stale rows for the same physical browser. Drop every other
    // row with this exact user agent (RLS delete-own policy applies).
    await supabase
      .from('user_devices')
      .delete()
      .eq('user_id', userId)
      .eq('user_agent', ua)
      .neq('device_id', deviceId);
  } catch {
    // Non-critical — don't block login
  }
};

/** Only devices seen within this window count as "active". */
const ACTIVE_WINDOW_DAYS = 45;

/**
 * List the current user's active devices: rows from the last 45 days, collapsed to
 * one per (device_name + user_agent) keeping the most recently seen — regenerated
 * device_ids used to show e.g. three identical "Mac · Chrome" rows — newest first.
 */
export const listDevices = async (): Promise<UserDevice[]> => {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .order('last_seen', { ascending: false });

  if (error) throw error;
  const rows = (data ?? []) as UserDevice[];

  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const byFingerprint = new Map<string, UserDevice>();
  for (const row of rows) {
    const seen = new Date(row.last_seen).getTime();
    if (!Number.isFinite(seen) || seen < cutoff) continue;
    const fingerprint = `${row.device_name}|${row.user_agent ?? ''}`;
    const kept = byFingerprint.get(fingerprint);
    if (!kept || new Date(kept.last_seen).getTime() < seen) byFingerprint.set(fingerprint, row);
  }

  return [...byFingerprint.values()].sort(
    (a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime()
  );
};

/** Remove a specific device record (does NOT invalidate its Supabase session). */
export const removeDevice = async (id: string): Promise<void> => {
  await supabase.from('user_devices').delete().eq('id', id);
};

/** The device_id of the current browser — used to highlight "this device" in the list. */
export const currentDeviceId = (): string => getDeviceId();

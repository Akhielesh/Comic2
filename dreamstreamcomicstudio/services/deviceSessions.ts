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
  } catch {
    // Non-critical — don't block login
  }
};

/** List all devices registered for the current user. */
export const listDevices = async (): Promise<UserDevice[]> => {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .order('last_seen', { ascending: false });

  if (error) throw error;
  return (data ?? []) as UserDevice[];
};

/** Remove a specific device record (does NOT invalidate its Supabase session). */
export const removeDevice = async (id: string): Promise<void> => {
  await supabase.from('user_devices').delete().eq('id', id);
};

/** The device_id of the current browser — used to highlight "this device" in the list. */
export const currentDeviceId = (): string => getDeviceId();

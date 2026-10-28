// Where to go after signing in (?next=…): a path on this site, normalised — or, with Stream Studio on
// its own host, its address. Everything else is refused (an open redirect on our own domain would make
// a perfect phishing link).
import { isStreamUrl, STREAM_HOST_ON } from '../shared/streamHost';

/**
 * The address to go to, or null. Control characters and backslashes are refused outright: browsers
 * drop tab/newline/CR from URLs and read '\' as '/', so '/\t/evil.com' or '/\evil.com' would
 * otherwise become '//evil.com'. A path is navigated to as parsed, never as typed.
 */
export function safeNext(p: string | null | undefined, origin: string = location.origin, allowStream: boolean = STREAM_HOST_ON): string | null {
  if (typeof p !== 'string' || !p || /[\u0000-\u001f\u007f\\]/.test(p)) return null;
  let url: URL;
  try {
    url = new URL(p, origin);
  } catch {
    return null;
  }
  if (p.startsWith('/') && !p.startsWith('//')) {
    // Check the NORMALISED path too: dot segments ('/.//evil.com', '/a/..//evil.com') parse to a
    // pathname of '//evil.com', which a browser then reads as another host.
    if (url.origin !== origin || url.pathname.startsWith('//')) return null;
    return url.pathname + url.search + url.hash;
  }
  return allowStream && isStreamUrl(p) ? url.href : null;
}

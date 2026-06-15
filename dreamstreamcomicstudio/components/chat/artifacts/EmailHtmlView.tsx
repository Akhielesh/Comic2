import React, { useEffect, useMemo, useRef, useState } from 'react';

// Secure renderer for an email's ORIGINAL HTML — the email "in its true form".
//
// Threat model: email HTML is fully untrusted. We render it in a SANDBOXED iframe with:
//   • sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" — note NO
//     allow-same-origin, so the frame is an opaque origin with no access to the parent,
//     our cookies, or storage.
//   • a strict CSP whose `script-src` is a per-render NONCE — so ONLY our injected
//     height-reporter runs; every script/inline-handler/`javascript:` URI in the email
//     is blocked (script-src without 'unsafe-inline' kills onclick=, onerror=, etc.).
//   • `default-src 'none'` — no objects/frames/forms/connections; images gated below.
//
// Remote images are BLOCKED by default (tracking pixels / open-tracking) and revealed
// with one click — same posture as Gmail. Inline (cid:) images are resolved to data URLs
// from the message's own attachments, so the real embedded images always show.
//
// Links get `<base target="_blank">` + a capture handler, and the popup sandbox flag,
// so clicking opens a real new tab (rel=noopener). Height is reported back via postMessage
// (validated by source + nonce) so the frame sizes to its content — no nested scrollbar.

const ACCENT = '#c2643f'; // theme-invariant studio accent, for unstyled email links

/** base64url → base64 (padded) for data: URLs. */
export const b64urlToDataUrl = (data: string, mimeType: string): string => {
  let b = (data || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return `data:${mimeType || 'application/octet-stream'};base64,${b}`;
};

const escapeAttr = (s: string): string => s.replace(/"/g, '&quot;');

/** Replace `cid:CONTENT-ID` references in the HTML with resolved data URLs (or drop them). */
const inlineCids = (html: string, cidMap: Record<string, string>): string =>
  html.replace(/(["'(])\s*cid:([^"')\s]+)\s*(["')])/gi, (_m, open: string, cid: string, close: string) => {
    const key = decodeURIComponent(cid.trim()).replace(/^<|>$/g, '');
    const url = cidMap[key];
    return url ? `${open}${url}${close}` : `${open}${close}`;
  });

const buildSrcDoc = (html: string, opts: { cidMap: Record<string, string>; showRemote: boolean; nonce: string }): string => {
  const body = inlineCids(html, opts.cidMap);
  const imgSrc = opts.showRemote ? "img-src data: https: http:;" : 'img-src data:;';
  const csp = [
    "default-src 'none'",
    imgSrc,
    'media-src data:',
    "style-src 'unsafe-inline'",
    'font-src https: data:',
    `script-src 'nonce-${opts.nonce}'`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'"
  ].join('; ');
  const styles =
    `<style>html,body{margin:0;padding:14px;background:#fff;color:#1a1915;` +
    `font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;` +
    `word-break:break-word;overflow-wrap:anywhere;}` +
    `img{max-width:100%!important;height:auto;}table{max-width:100%!important;}` +
    `*{max-width:100%;box-sizing:border-box;}` +
    `a{color:${ACCENT};}</style>`;
  // The reporter: report height + force every link to open in a new tab. Email scripts
  // can't forge the nonce (random per render), so only this runs.
  const reporter =
    `<script nonce="${opts.nonce}">(function(){` +
    `function h(){try{parent.postMessage({__emailHeight:true,nonce:'${opts.nonce}',` +
    `height:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)},'*');}catch(e){}}` +
    `h();window.addEventListener('load',h);` +
    `try{if(window.ResizeObserver){new ResizeObserver(h).observe(document.documentElement);}}catch(e){}` +
    `setTimeout(h,250);setTimeout(h,1000);setTimeout(h,2500);` +
    `document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');` +
    `if(a){a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');}},true);` +
    `})();</script>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">` +
    `<base target="_blank">${styles}</head><body>${body}${reporter}</body></html>`
  );
};

/** True when the HTML references any remote (http/https) image — drives the "show images" prompt. */
export const hasRemoteImages = (html: string): boolean => /<img[^>]+src\s*=\s*["']?https?:/i.test(html);

export const EmailHtmlView: React.FC<{
  html: string;
  /** Content-ID → data URL for inline images (from the message's attachments). */
  cidMap?: Record<string, string>;
  showRemote: boolean;
}> = ({ html, cidMap, showRemote }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(280);
  const map = cidMap || {};
  // New nonce whenever the rendered content changes.
  const nonce = useMemo(
    () => `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    [html, showRemote, map]
  );
  const srcDoc = useMemo(() => buildSrcDoc(html, { cidMap: map, showRemote, nonce }), [html, map, showRemote, nonce]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return; // only OUR frame
      const d = e.data as { __emailHeight?: boolean; nonce?: string; height?: number } | null;
      if (d && d.__emailHeight && d.nonce === nonce && typeof d.height === 'number') {
        setHeight(Math.min(24000, Math.max(80, Math.ceil(d.height))));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [nonce]);

  return (
    <iframe
      ref={iframeRef}
      title="Email message"
      // No allow-same-origin: opaque origin, no parent/cookie/storage access.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="w-full rounded-lg border border-[var(--ds-hairline-soft)] bg-white"
      style={{ height, colorScheme: 'light' }}
    />
  );
};

import React, { useEffect, useRef } from 'react';
import { TURNSTILE_SITE_KEY } from '../services/clientConfig';

// Cloudflare Turnstile widget. Renders nothing (and requires nothing) unless
// VITE_TURNSTILE_SITE_KEY is set, so the whole feature is dormant until the owner adds keys.

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
    __dsTurnstileLoading?: Promise<void>;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const loadScript = (): Promise<void> => {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (window.__dsTurnstileLoading) return window.__dsTurnstileLoading;
  window.__dsTurnstileLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Turnstile'));
    document.head.appendChild(s);
  });
  return window.__dsTurnstileLoading;
};

interface TurnstileProps {
  /** Called with a fresh token when the challenge is solved. */
  onToken: (token: string) => void;
  /** Called when the token expires or errors — clear any stored token. */
  onExpire?: () => void;
  /** Optional action label for analytics in the Turnstile dashboard. */
  action?: string;
  className?: string;
}

/** Imperatively reset all Turnstile widgets (call after a submit so a fresh token is issued). */
export const resetTurnstile = (): void => {
  try {
    window.turnstile?.reset();
  } catch {
    /* noop */
  }
};

export const Turnstile: React.FC<TurnstileProps> = ({ onToken, onExpire, action, className }) => {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const cbs = useRef({ onToken, onExpire });
  cbs.current = { onToken, onExpire };

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          callback: (token: string) => cbs.current.onToken(token),
          'expired-callback': () => cbs.current.onExpire?.(),
          'error-callback': () => cbs.current.onExpire?.(),
          theme: 'light'
        });
      })
      .catch(() => {
        /* network/script failure — fail open client-side; the server still enforces if configured */
      });
    return () => {
      cancelled = true;
      try {
        if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      } catch {
        /* noop */
      }
      widgetId.current = null;
    };
  }, [action]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={ref} className={className} />;
};

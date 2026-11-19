/**
 * AlertsHost (notify SPEC §6 NF-4): turns the alert core on for a signed-in person and off at sign-out. Mounted once
 * beside the app's ToastHost; it renders nothing. The core is loaded only once someone is signed in (a separate
 * chunk: signed-out visitors, the landing and the public reader never download it), and it is stopped — what waited
 * dropped, the tab count cleared, the audio closed, held comic streams aborted (the core's stop hooks) — when the
 * account changes or the person signs out. Open on an alert routes here: a comic opens in the studio; a chat becomes
 * the chat Chat opens (and a Chat already on screen switches to it). The core counts an Open through telemetry,
 * with the kind only.
 */
import { useEffect, useRef } from 'react';
import { setLastActiveChatSessionId } from '../../services/chatStorage';
import { requestChatOpen } from '../../services/alerts/chatOpen';
import { captureEvent } from '../../services/telemetry';

export interface AlertsHostProps {
  /** The signed-in person; null while signed out (nothing runs). */
  accountId: string | null;
  /** Open a comic in the studio. */
  onOpenComic(projectId: string): void;
  /** Go to Chat (the chat to open is already chosen). */
  onOpenChat(sessionId: string): void;
}

type Core = typeof import('../../services/alerts/bus');

/** The loaded core (one per page; the import is cached by the bundler). */
let core: Core | null = null;
const loadCore = (): Promise<Core> => import('../../services/alerts/bus').then((mod) => (core = mod));

export function AlertsHost({ accountId, onOpenComic, onOpenChat }: AlertsHostProps): null {
  const routes = useRef({ onOpenComic, onOpenChat });
  routes.current = { onOpenComic, onOpenChat };

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void loadCore()
      .then((bus) => {
        if (!live) return;
        bus.startAlerts({
          accountId,
          open: (target) => {
            if (target.app === 'chat') {
              setLastActiveChatSessionId(target.id);
              routes.current.onOpenChat(target.id);
              requestChatOpen(target.id);
              return;
            }
            routes.current.onOpenComic(target.id);
          },
          track: (eventType, metadata) => captureEvent({ eventType, severity: 'info', metadata: { ...metadata } })
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      core?.stopAlerts();
    };
  }, [accountId]);

  return null;
}

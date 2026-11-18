import React, { useEffect, useState } from 'react';
import { Check, AlertTriangle, Circle, ChevronDown, ChevronUp, ArrowRight, X, Rocket } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ALL_PROVIDERS, getActiveKey, isOverLimit, PROVIDER_META } from '../services/apiKeys';
import { getModelSelection } from '../services/modelSelection';
import { Badge, Button, IconButton } from './ds';
import { DENSITY, FOCUS_RING, RADIUS_CONTROL, SECTION_CARD, STATUS_INK, TRANSITION, WRAP_TEXT } from './chat/studioDesign';
import { cn } from '../lib/utils';

type Status = 'done' | 'todo' | 'warn';

interface CheckItem {
  id: string;
  label: string;
  status: Status;
  help: string;
  action?: { label: string; view: string };
}

interface ReadinessChecklistProps {
  /** Navigate to a view to resolve a blocker (e.g. 'settings', 'models', 'auth'). */
  onNavigate?: (view: string) => void;
}

const STATUS_ICON: Record<Status, React.ReactNode> = {
  done: <Check className={cn('w-4 h-4', STATUS_INK.healthy)} aria-hidden />,
  todo: <Circle className={cn('w-4 h-4', STATUS_INK.waiting)} aria-hidden />,
  warn: <AlertTriangle className={cn('w-4 h-4', STATUS_INK.attention)} aria-hidden />
};

const buildItems = (hasUser: boolean): CheckItem[] => {
  const items: CheckItem[] = [];

  items.push(
    hasUser
      ? { id: 'account', label: 'Signed in', status: 'done', help: 'Your projects are saved to your account.' }
      : { id: 'account', label: 'Sign in to create & save', status: 'todo', help: 'Reading comics is free, but creating and saving needs an account.', action: { label: 'Sign in', view: 'auth' } }
  );

  const activeKey = ALL_PROVIDERS.map((p) => getActiveKey(p)).find(Boolean) || null;
  const openRouterKey = getActiveKey('openrouter');
  if (!activeKey) {
    items.push({ id: 'key', label: 'Add an API key', status: 'todo', help: 'The studio generates with your own key (BYOK). Add an OpenRouter key (recommended) or Gemini / Pixazo.', action: { label: 'Add key', view: 'settings' } });
  } else if (isOverLimit(activeKey)) {
    items.push({ id: 'key', label: `${PROVIDER_META[activeKey.provider].label} key over its limit`, status: 'warn', help: `"${activeKey.label}" reached its monthly limit. Switch to another key or raise the limit.`, action: { label: 'Manage keys', view: 'settings' } });
  } else {
    items.push({ id: 'key', label: `Active key: ${activeKey.label}`, status: 'done', help: `Generating with your ${PROVIDER_META[activeKey.provider].label} key.` });
  }

  const selection = getModelSelection();
  const imageReady = !!selection.imageModel || !!openRouterKey;
  items.push(
    imageReady
      ? { id: 'model', label: selection.imageModel ? 'Image model chosen' : 'Using default image model', status: 'done', help: 'Change it anytime in the Model Library.' }
      : { id: 'model', label: 'Choose an image model', status: 'todo', help: 'Pick an image model (or add an OpenRouter key to use the default).', action: { label: 'Open Model Library', view: 'models' } }
  );

  return items;
};

/**
 * Onboarding/readiness checklist. Surfaces concrete blockers (no account, no API
 * key, no model) with a one-click fix for each, so setup gaps are visible instead
 * of failing mid-flow. Hides itself once everything is ready.
 */
export const ReadinessChecklist: React.FC<ReadinessChecklistProps> = ({ onNavigate }) => {
  const { user } = useAuth();
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [, setTick] = useState(0);

  // Re-evaluate when the window regains focus (e.g. after setting a key in Settings).
  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const items = buildItems(!!user);
  const remaining = items.filter((i) => i.status !== 'done').length;

  // Nothing to nudge about, or the user dismissed it → stay out of the way.
  if (remaining === 0 || dismissed) return null;

  const doneCount = items.length - remaining;

  return (
    <div className={cn('mb-6 overflow-hidden', SECTION_CARD)}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn('-ml-2 flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5 text-left text-[length:var(--ds-text-lg)] font-semibold leading-6 hover:bg-[var(--ds-hover)]', DENSITY.coarse, RADIUS_CONTROL, TRANSITION, FOCUS_RING)}
        >
          <Rocket className="w-5 h-5 shrink-0" aria-hidden /> Get set up
          <Badge variant="secondary" className="tabular-nums">{doneCount}/{items.length} ready</Badge>
          {open ? <ChevronUp className="w-4 h-4 shrink-0" aria-hidden /> : <ChevronDown className="w-4 h-4 shrink-0" aria-hidden />}
        </button>
        <IconButton label="Dismiss" onClick={() => setDismissed(true)}><X /></IconButton>
      </div>

      {open && (
        <ul className="divide-y divide-[var(--ds-hairline)]">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className="mt-0.5 shrink-0">{STATUS_ICON[item.status]}</span>
              <div className="flex-1 min-w-0 basis-40">
                <div className={cn('text-[length:var(--ds-text-base)] font-semibold leading-5', item.status === 'done' ? 'text-[var(--ds-muted)]' : 'text-[var(--ds-ink)]')}>{item.label}</div>
                {item.status !== 'done' && <div className={cn('mt-0.5 text-[length:var(--ds-text-sm)] leading-5 text-[var(--ds-muted)]', WRAP_TEXT)}>{item.help}</div>}
              </div>
              {item.action && item.status !== 'done' && (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => onNavigate?.(item.action!.view)}>
                  {item.action.label} <ArrowRight aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

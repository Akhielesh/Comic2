import React, { useEffect, useState } from 'react';
import { Check, AlertTriangle, Circle, ChevronDown, ChevronUp, ArrowRight, X, Rocket } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ALL_PROVIDERS, getActiveKey, isOverLimit, PROVIDER_META } from '../services/apiKeys';
import { getModelSelection } from '../services/modelSelection';

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
  done: <Check className="w-4 h-4 text-green-600" />,
  todo: <Circle className="w-4 h-4 text-slate-400" />,
  warn: <AlertTriangle className="w-4 h-4 text-amber-600" />
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
    <div className="mb-6 bg-white border-2 border-black rounded-xl shadow-comic overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-brand-yellow/30 border-b-2 border-black">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 font-display text-lg">
          <Rocket className="w-5 h-5" /> Get set up
          <span className="text-xs font-bold uppercase bg-white border-2 border-black rounded-full px-2 py-0.5">{doneCount}/{items.length} ready</span>
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        <button onClick={() => setDismissed(true)} title="Dismiss" className="p-1 border-2 border-black rounded hover:bg-white"><X className="w-3.5 h-3.5" /></button>
      </div>

      {open && (
        <ul className="divide-y divide-slate-200">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 shrink-0">{STATUS_ICON[item.status]}</span>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-bold ${item.status === 'done' ? 'text-slate-500' : 'text-slate-900'}`}>{item.label}</div>
                {item.status !== 'done' && <div className="text-xs text-slate-600 mt-0.5">{item.help}</div>}
              </div>
              {item.action && item.status !== 'done' && (
                <button
                  onClick={() => onNavigate?.(item.action!.view)}
                  className="shrink-0 text-xs font-bold px-2.5 py-1 rounded border-2 border-black bg-brand-blue text-white hover:bg-brand-blue/90 flex items-center gap-1"
                >
                  {item.action.label} <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

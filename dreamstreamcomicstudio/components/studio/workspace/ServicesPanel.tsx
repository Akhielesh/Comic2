// ServicesPanel (Sprint 4.1): surfaces the backends/connections the AI's code expects — detected
// from the project (Supabase, Postgres, Stripe, storage, an LLM provider, …) plus the env vars it
// references. Offers a real, working action now (scaffold a .env.example) and a path to connect the
// user's own accounts (the OAuth wiring is the owner-action list). Renders nothing when the project
// needs no services/env. House-styled, driven by the pure detectServices().

import React from 'react';
import { Plug, KeyRound, Plus, Check, ArrowRight } from 'lucide-react';
import { useStudioTheme } from '../kit';
import { detectServices, buildEnvExample } from './serviceDetect';

export interface ServicesPanelProps {
  files: { path: string; content?: string }[];
  /** True when /.env.example already exists (disables the scaffold button). */
  hasEnvExample: boolean;
  /** Write the generated .env.example into the project. */
  onAddEnvExample: (content: string) => void;
  /** Take the user to account connections (Settings). */
  onConnect: () => void;
}

export const ServicesPanel: React.FC<ServicesPanelProps> = ({ files, hasEnvExample, onAddEnvExample, onConnect }) => {
  const t = useStudioTheme();
  const { services, envVars } = React.useMemo(() => detectServices(files), [files]);

  if (services.length === 0 && envVars.length === 0) return null;

  return (
    <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden`} aria-label="Services and connections">
      <div className={`flex items-center gap-2 px-2.5 py-2 border-b ${t.edge}`}>
        <Plug className={`h-3.5 w-3.5 ${t.accent}`} />
        <span className={`text-xs font-semibold ${t.text}`}>Services &amp; connections</span>
        {services.length > 0 && (
          <span className={`ml-auto text-[10px] tabular-nums ${t.textFaint}`}>{services.length} detected</span>
        )}
      </div>

      <div className="px-2.5 py-2 space-y-2.5">
        {services.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {services.map((s) => (
              <span
                key={s.id}
                className={`inline-flex items-center gap-1 rounded-full border ${t.edge} ${t.panelAlt} px-2 py-0.5 text-[11px] font-medium ${t.textDim}`}
              >
                {s.label}
              </span>
            ))}
          </div>
        )}

        {envVars.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <KeyRound className={`h-3 w-3 ${t.textFaint}`} />
              <span className={`text-[11px] font-semibold ${t.textDim}`}>
                Expects {envVars.length} env var{envVars.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {envVars.slice(0, 12).map((k) => (
                <code key={k} className={`rounded border ${t.edge} ${t.panelAlt} px-1.5 py-0.5 font-mono text-[10px] ${t.textDim}`}>{k}</code>
              ))}
              {envVars.length > 12 && <span className={`text-[10px] ${t.textFaint}`}>+{envVars.length - 12} more</span>}
            </div>
            <button
              onClick={() => onAddEnvExample(buildEnvExample(envVars))}
              disabled={hasEnvExample}
              title={hasEnvExample ? '/.env.example already exists' : 'Create /.env.example with these keys'}
              className={`inline-flex items-center gap-1.5 rounded-full border ${t.edge} px-2.5 py-1 text-[11px] font-semibold ${t.textDim} ${t.hover} disabled:opacity-50 ${t.focusRing}`}
            >
              {hasEnvExample ? <Check className="h-3 w-3 text-emerald-400" /> : <Plus className="h-3 w-3" />}
              {hasEnvExample ? '.env.example added' : 'Add .env.example'}
            </button>
          </div>
        )}

        {services.length > 0 && (
          <button
            onClick={onConnect}
            className={`group flex w-full items-center gap-1.5 rounded-md border ${t.edge} px-2.5 py-1.5 text-left text-[11px] ${t.hover} ${t.focusRing}`}
            title="Connect your own accounts to provision these"
          >
            <span className={`font-semibold ${t.text}`}>Connect your accounts</span>
            <span className={`${t.textFaint}`}>to provision these</span>
            <ArrowRight className={`ml-auto h-3 w-3 ${t.textFaint} transition-transform group-hover:translate-x-0.5`} />
          </button>
        )}
      </div>
    </div>
  );
};

// Pure classifier: map a backlog goal to the EngineAction it performs, so the DECIDE gate can
// route risky goals (production deploys, destructive ops, external publishing) through their
// human checkpoint instead of letting the loop do them autonomously. Epic A4 prep.
// Conservative by design: when in doubt it returns 'run_build' (an in-sandbox, no-checkpoint
// action) — it never *downgrades* a risky-looking goal to a safe one.

import type { EngineAction } from './checkpoints.js';

export interface ClassifiableGoal {
  title: string;
  detail?: string;
  kind?: string;
}

const has = (text: string, re: RegExp): boolean => re.test(text);

export const classifyGoalAction = (goal: ClassifiableGoal): EngineAction => {
  const text = `${goal.title} ${goal.detail || ''}`.toLowerCase();

  // Destructive data/resource operations — highest caution.
  if (has(text, /\b(delete|drop|destroy|wipe|purge|tear down|teardown)\b/) && has(text, /\b(database|db|table|schema|bucket|resource|deployment|data|records?)\b/)) {
    return 'delete_resource';
  }

  // External publishing under the user's brand (announcements, listings, public posts).
  // Checked before deploy so "announce launch to users" routes to publishing, not a deploy.
  if (has(text, /\b(publish|announce|submit to|list on|post to)\b/) && has(text, /\b(public|store|marketplace|directory|press|social|users?)\b/)) {
    return 'publish_external';
  }

  // Production deploy / go-live.
  if (has(text, /\b(go[- ]?live|production deploy|deploy to prod|ship to prod|launch)\b/) || (has(text, /\bdeploy\b/) && has(text, /\bprod(uction)?\b/))) {
    return 'deploy_production';
  }

  // Preview / staging deploy — managed, no checkpoint.
  if (has(text, /\b(deploy|preview|staging)\b/) && !has(text, /\bprod/)) {
    return 'deploy_preview';
  }

  // Default: an in-sandbox build/edit — safe, no checkpoint.
  return 'run_build';
};

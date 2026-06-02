// Built-in check: under costPref='free-only', pickTextModel + pickImageModel must
// either return a free_verified id or throw NoFreeModelAvailableError. Anything that
// returns a non-free id breaks the "Block + explain" contract and would silently
// bill the caller's key.

import crypto from 'node:crypto';
import { getCatalog } from '../../services/modelCatalog.js';
import {
  pickTextModel,
  pickImageModel,
  NoFreeModelAvailableError
} from '../../ai/autoRouter.js';
import { classifyModel } from '../../../../shared/pricing.js';
import type { AnnotatedModel } from '../../ai/catalogAnnotations.js';
import type { CheckImpl, RawFinding } from '../types.js';

const fp = (parts: string[]) => crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);

export const autorouterFreeInvariant: CheckImpl = {
  builtinId: 'autorouter_free_invariant',
  description: 'Under free-only, autorouter never returns a non-free model id (or throws clearly).',
  kind: 'deterministic',
  target: 'autorouter',
  severity: 'critical',
  async run(_record, ctx) {
    const findings: RawFinding[] = [];
    let catalog;
    try {
      catalog = await getCatalog();
    } catch (err) {
      ctx.log('Failed to fetch catalog', { error: (err as Error).message });
      return findings;
    }
    const byId = new Map<string, AnnotatedModel>(catalog.models.map((m) => [m.id, m]));
    const verify = async (kind: 'text' | 'image', fn: () => Promise<string>) => {
      try {
        const id = await fn();
        const m = byId.get(id);
        if (!m) {
          findings.push({
            fingerprint: fp(['autorouter_free_invariant', kind, 'unknown_id', id]),
            title: `Free-only ${kind} pick returned id not present in live catalog: ${id}`,
            detail: { kind, returnedId: id, evidence: 'autorouter returned an id absent from getCatalog().' },
            severity: 'high',
            confidence: 1
          });
          return;
        }
        const cls = classifyModel({
          modelId: m.id,
          pricing: m.pricing,
          supportsImageOutput: m.supportsImageOutput
        });
        if (cls !== 'free_verified') {
          findings.push({
            fingerprint: fp(['autorouter_free_invariant', kind, 'leaked_paid', id, cls]),
            title: `Free-only ${kind} pick returned a non-free model (${cls}): ${id}`,
            detail: {
              kind,
              returnedId: id,
              actualClass: cls,
              pricing: m.pricing,
              evidence:
                'autorouter.pickTextModel/pickImageModel returned a model that classifyModel() does NOT consider free_verified. Under free-only, this would charge the caller\'s key.',
              suggestedFix:
                'Tighten autoRouter.ts isFreeVerified() to use classifyModel directly, and ensure NoFreeModelAvailableError is thrown when no truly-free model passes the gate.'
            },
            severity: 'critical',
            confidence: 1
          });
        }
      } catch (err) {
        if (err instanceof NoFreeModelAvailableError) {
          ctx.log(`Free-only ${kind}: NoFreeModelAvailableError (expected when catalog has none)`, {
            kind,
            message: err.message
          });
          return; // legitimate "block" — that's the contract.
        }
        // Some other error: not a free-only violation, but worth recording at low severity.
        findings.push({
          fingerprint: fp(['autorouter_free_invariant', kind, 'unexpected_error']),
          title: `Free-only ${kind} pick threw an unexpected error`,
          detail: { kind, error: (err as Error).message, name: (err as Error).name },
          severity: 'med',
          confidence: 1
        });
      }
    };

    await verify('text', () => pickTextModel({ costPref: 'free-only' }));
    await verify('image', () => pickImageModel({ costPref: 'free-only' }));
    return findings;
  }
};

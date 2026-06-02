// Built-in check: cross-provider cost sanity.
//
// Today this is a thin starter: it asserts that NVIDIA Build models in the live
// catalog are classified free_verified (since the route uses byokBypass = $0 to the
// user) and that no Pixazo image model is mis-labelled free with a non-zero per-image
// price. We can grow this as we add providers.

import crypto from 'node:crypto';
import { getCatalog } from '../../services/modelCatalog.js';
import type { CheckImpl, RawFinding } from '../types.js';

const fp = (parts: string[]) => crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);

export const multiProviderCost: CheckImpl = {
  builtinId: 'multi_provider_cost',
  description: 'NVIDIA models stay free_verified; Pixazo image models with per-image cost are not labelled free.',
  kind: 'deterministic',
  target: 'multi_provider_cost',
  severity: 'med',
  async run(_record, ctx) {
    const findings: RawFinding[] = [];
    let catalog;
    try {
      catalog = await getCatalog();
    } catch (err) {
      ctx.log('Failed to fetch catalog', { error: (err as Error).message });
      return findings;
    }
    for (const m of catalog.models) {
      if (m.source === 'nvidia' && m.costClass !== 'free_verified') {
        findings.push({
          fingerprint: fp(['multi_provider_cost', 'nvidia_not_free', m.id]),
          title: `NVIDIA model "${m.id}" is not free_verified`,
          detail: {
            modelId: m.id,
            costClass: m.costClass,
            pricing: m.pricing,
            evidence:
              'NVIDIA Build is a billing-bypassed BYOK free tier, so every NVIDIA model should be free_verified to the user.',
            suggestedFix: 'Check server/src/ai/providers/nvidia.ts normalizeCatalogModel — costClass must be free_verified.'
          },
          severity: 'med',
          confidence: 1
        });
      }
      if (m.id.toLowerCase().includes('pixazo') && m.isFree && m.pricing.imagePerImage > 0) {
        findings.push({
          fingerprint: fp(['multi_provider_cost', 'pixazo_mislabel', m.id]),
          title: `Pixazo image model "${m.id}" labelled free yet has per-image cost`,
          detail: {
            modelId: m.id,
            pricing: m.pricing,
            evidence: 'imagePerImage > 0 contradicts an isFree=true label.'
          },
          severity: 'high',
          confidence: 1
        });
      }
    }
    return findings;
  }
};

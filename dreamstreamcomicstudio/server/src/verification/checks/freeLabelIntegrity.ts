// Built-in check: every "free"-labelled model in the live catalog is genuinely free.
//
// Catches the "$0 per image but token-billed" trap (Gemini Nano Banana style) and any
// other case where the catalog row would render a green "Free" badge while still
// charging the user's key.

import crypto from 'node:crypto';
import { getCatalog } from '../../services/modelCatalog.js';
import { classifyModel } from '../../../../shared/pricing.js';
import type { CheckImpl, RawFinding } from '../types.js';

const fp = (parts: string[]) => crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);

export const freeLabelIntegrity: CheckImpl = {
  builtinId: 'free_label_integrity',
  description: 'Every model labelled "free" in the live catalog is actually free_verified.',
  kind: 'deterministic',
  target: 'free_labeling',
  severity: 'high',
  async run(_record, ctx) {
    const findings: RawFinding[] = [];
    let catalog;
    try {
      catalog = await getCatalog();
    } catch (err) {
      ctx.log('Failed to fetch catalog', { error: (err as Error).message });
      return findings;
    }

    for (const model of catalog.models) {
      const claimedFree = Boolean(model.isFree);
      const actualClass = classifyModel({
        modelId: model.id,
        pricing: model.pricing,
        supportsImageOutput: model.supportsImageOutput
      });
      const actuallyFree = actualClass === 'free_verified';
      if (claimedFree && !actuallyFree) {
        findings.push({
          fingerprint: fp(['free_label_integrity', model.id, actualClass]),
          title: `Model "${model.id}" is labelled free but is ${actualClass}`,
          detail: {
            modelId: model.id,
            modelName: model.name,
            claimedFree,
            actualClass,
            pricing: model.pricing,
            supportsImageOutput: model.supportsImageOutput,
            evidence:
              'isFree=true on the catalog row, but classifyModel() disagrees. Most often: image model with imagePerImage=0 yet completionPerToken>0 (token-billed image).',
            suggestedFix:
              'Refresh isFree to derive from shared/pricing.classifyModel(...) === "free_verified" in services/modelCatalog.ts'
          },
          severity: 'high',
          confidence: 1
        });
      }
      if (!claimedFree && actuallyFree) {
        // The opposite: model is genuinely free but UI won't surface it. Low-severity hint.
        findings.push({
          fingerprint: fp(['free_label_integrity_neg', model.id]),
          title: `Model "${model.id}" is genuinely free but not labelled so`,
          detail: {
            modelId: model.id,
            modelName: model.name,
            claimedFree,
            actualClass,
            pricing: model.pricing,
            evidence:
              'classifyModel() says free_verified (id ends :free or all 4 axes are 0) but isFree=false. Users miss a free option.'
          },
          severity: 'low',
          confidence: 1
        });
      }
    }
    return findings;
  }
};

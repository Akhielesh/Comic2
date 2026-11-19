// "The models behind it" and "Pricing": two ink-only sections (no tile, hue, wash or chip in or beside them). The
// models section reads every name and number from the studio's registries (landingModels.ts); pricing says only what
// is certain today and names no amount, plan or date.
import React from 'react';
import { MODELS, PRICING, fill } from './landingCopy';
import { LANDING_VALUES } from './landingModels';
import { SectionHead } from './parts';

export const ModelsSection: React.FC = () => (
  <section id="models" aria-labelledby="landing-models" className="landing-section">
    <SectionHead id="landing-models" eyebrow={MODELS.eyebrow} title={MODELS.title} />
    <dl className="landing-models">
      {MODELS.items.map((item) => (
        <div key={item.title} className="landing-model ds-reveal">
          <dt className="landing-model-title">{item.title}</dt>
          <dd className="landing-body">{fill(item.body, LANDING_VALUES)}</dd>
        </div>
      ))}
    </dl>
    <p className="landing-note">{MODELS.note}</p>
  </section>
);

export const PricingSection: React.FC = () => (
  <section id="pricing" aria-labelledby="landing-pricing" className="landing-section">
    <SectionHead id="landing-pricing" title={PRICING.title} />
    <ul className="landing-pricing">
      {PRICING.lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  </section>
);

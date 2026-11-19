// "How it works": three steps on a rail, ink only.
import React from 'react';
import { cn } from '../../../lib/utils';
import { FONT_DISPLAY } from '../../chat/studioDesign';
import { HOW } from './landingCopy';
import { SectionHead } from './parts';

export const HowItWorks: React.FC = () => (
  <section id="how-it-works" aria-labelledby="landing-how" className="landing-section">
    <SectionHead id="landing-how" eyebrow={HOW.eyebrow} title={HOW.title} />
    <ol className="landing-steps">
      {HOW.steps.map((step, i) => (
        <li key={step.title} data-step={i + 1} className="landing-step ds-reveal">
          <span aria-hidden className="landing-step-dot" />
          <span aria-hidden className="landing-count">{String(i + 1).padStart(2, '0')}</span>
          <h3 className={cn('landing-step-title', FONT_DISPLAY)}>{step.title}</h3>
          <p className="landing-body">{step.body}</p>
        </li>
      ))}
    </ol>
  </section>
);

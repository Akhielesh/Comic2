// Real studio walkthroughs and the workspace actions that follow them.
import React from 'react';
import { Languages, MessageSquareText, Share2, Type } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FONT_DISPLAY, HUE_SOLID, INK_TILE } from '../../chat/studioDesign';
import { FEATURES, FEATURES_HEAD, fill } from './landingCopy';
import { landingMedia, type LandingMedia } from './landingMedia';
import { LANDING_VALUES } from './landingModels';
import { LandingFigure, SectionHead } from './parts';

type Icon = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const ROWS: ReadonlyArray<{ icon: Icon; tile: string; media: LandingMedia }> = [
  { icon: MessageSquareText, tile: INK_TILE, media: landingMedia('plan') },
  { icon: Type, tile: HUE_SOLID[1], media: landingMedia('lettering') },
  { icon: Languages, tile: HUE_SOLID[5], media: landingMedia('languages') },
  { icon: Share2, tile: HUE_SOLID[6], media: landingMedia('share') }
];

export const FeaturesSection: React.FC<React.PropsWithChildren> = ({ children }) => (
  <section id="features" aria-labelledby="landing-features" className="landing-section">
    <SectionHead id="landing-features" eyebrow={FEATURES_HEAD.eyebrow} title={FEATURES_HEAD.title}>
      <p className="landing-lead">{FEATURES_HEAD.intro}</p>
    </SectionHead>
    <ol className="landing-features">
      {FEATURES.map((feature, i) => {
        const { icon: FeatureIcon, tile, media } = ROWS[i];
        return (
          <li key={feature.title} data-feature={media.id} className="landing-feature ds-reveal">
            <div className="landing-feature-copy">
              <div className="landing-feature-mark">
                <span aria-hidden data-feature-tile className={cn('landing-tile', tile)}>
                  <FeatureIcon aria-hidden />
                </span>
                <h3 className={cn('landing-feature-title', FONT_DISPLAY)}>{feature.title}</h3>
              </div>
              {feature.lines.map((line) => (
                <p key={line} className="landing-body">
                  {fill(line, LANDING_VALUES)}
                </p>
              ))}
            </div>
            <LandingFigure media={media} className="landing-feature-figure" />
          </li>
        );
      })}
    </ol>
    {children}
  </section>
);

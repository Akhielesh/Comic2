// One still of the landing: the theme's WebP at its declared size, loaded lazily (every still sits below the first
// screen), decoded off the main thread, with alt text that says what the picture shows. A narrow window gets the
// still's phone crop instead when it has one (a <picture> source with its own size, so nothing shifts), which keeps the
// words in the picture readable on a phone. The frame and caption belong to the caller (LandingFigure).
import React from 'react';
import { PHONE_MEDIA, type LandingMedia } from './landingMedia';
import { useDarkClass } from './useDarkClass';

export const LandingShot: React.FC<{ media: LandingMedia }> = ({ media }) => {
  const dark = useDarkClass();
  const src = (dark ? media.dark : media.light).webp;
  const phone = media.phone;
  const phoneSrc = phone ? (dark ? phone.dark : phone.light).webp : undefined;
  return (
    <picture data-landing-picture={media.id}>
      {phone && phoneSrc ? <source media={PHONE_MEDIA} srcSet={phoneSrc} width={phone.width} height={phone.height} /> : null}
      <img
        src={src}
        alt={media.alt}
        width={media.width}
        height={media.height}
        loading="lazy"
        decoding="async"
        data-landing-media={media.id}
        className="landing-media"
      />
    </picture>
  );
};

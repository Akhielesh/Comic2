// A short, muted, looping clip of a real flow. It plays only while at least half of it is in view (an
// IntersectionObserver, no timer) and pauses when it leaves, one clip at a time. Under reduced motion it never starts
// by itself: the poster shows with a Play control. The Play / Pause toggle is always there (44 px under a coarse
// pointer); once a visitor pauses, the clip stays paused when it scrolls back into view. Nothing loads until the clip
// nears the screen (preload="none"), and a play() the browser refuses leaves the poster and Play showing, quietly.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { IconButton } from '../../ds/IconButton';
import { useReducedMotion } from '../../ds/useReducedMotion';
import type { LandingMedia } from './landingMedia';
import { useDarkClass } from './useDarkClass';

/** The clip playing now, page-wide: starting another pauses it. */
let current: HTMLVideoElement | null = null;

export const LandingClip: React.FC<{ media: LandingMedia }> = ({ media }) => {
  const dark = useDarkClass();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  /** The visitor paused it: scrolling back into view does not restart it. */
  const heldRef = useRef(false);
  const sources = dark ? media.dark : media.light;

  const start = useCallback(() => {
    const video = ref.current;
    if (!video) return;
    if (current && current !== video) current.pause();
    current = video;
    let attempt: Promise<void> | undefined;
    try {
      attempt = video.play();
    } catch {
      setPlaying(false);
      return;
    }
    if (attempt && typeof attempt.then === 'function') {
      attempt.then(
        () => setPlaying(true),
        () => setPlaying(false)
      );
    } else {
      setPlaying(true);
    }
  }, []);

  const stop = useCallback(() => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    if (current === video) current = null;
    setPlaying(false);
  }, []);

  // In view: play (unless reduced motion or a visitor's pause); out of view: pause.
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!reduced && !heldRef.current) start();
          } else if (!video.paused) {
            stop();
          }
        }
      },
      { threshold: [0, 0.5] }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [reduced, start, stop, dark]);

  // Another clip took over (or the browser paused it): follow the element.
  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;
    const onPause = () => setPlaying(false);
    video.addEventListener('pause', onPause);
    return () => {
      video.removeEventListener('pause', onPause);
      if (current === video) current = null;
    };
  }, [dark]);

  const toggle = () => {
    if (playing) {
      heldRef.current = true;
      stop();
    } else {
      heldRef.current = false;
      start();
    }
  };

  const name = media.short || media.caption;
  return (
    <div className="landing-clip">
      <video
        key={dark ? 'dark' : 'light'}
        ref={ref}
        muted
        loop
        playsInline
        preload="none"
        poster={sources.poster}
        width={media.width}
        height={media.height}
        aria-label={media.alt}
        data-landing-media={media.id}
        className="landing-media"
      >
        {sources.webm ? <source src={sources.webm} type="video/webm" /> : null}
        {sources.mp4 ? <source src={sources.mp4} type="video/mp4" /> : null}
      </video>
      <IconButton
        label={`${playing ? 'Pause' : 'Play'}: ${name}`}
        title={null}
        variant="secondary"
        size="lg"
        className="landing-clip-toggle"
        onClick={toggle}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </IconButton>
    </div>
  );
};

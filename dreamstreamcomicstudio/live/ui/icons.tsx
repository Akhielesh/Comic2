// Stream Studio icon set. Stroke-based, 24×24, currentColor.
import React, { createElement as h } from 'react';

const P = (d: string, extra?: Record<string, unknown>) => h('path', { d, ...(extra || {}) });

const ICONS: Record<string, React.ReactElement[]> = {
  // nav
  grid: [P('M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z')],
  broadcast: [P('M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2'), P('M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4'), h('circle', { cx: 12, cy: 12, r: 2, fill: 'currentColor', stroke: 'none' })],
  sliders: [P('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6')],
  chart: [P('M3 3v18h18'), P('M7 14l3-4 4 3 5-7')],
  film: [P('M3 4h18v16H3zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4')],
  // transport / av
  mic: [P('M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z'), P('M5 11a7 7 0 0 0 14 0M12 18v3')],
  micOff: [P('M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7'), P('M5 11a7 7 0 0 0 10.7 6M19 11a7 7 0 0 1-.6 2.8M12 18v3'), P('M3 3l18 18')],
  video: [P('M2 6.5A1.5 1.5 0 0 1 3.5 5h11A1.5 1.5 0 0 1 16 6.5v11A1.5 1.5 0 0 1 14.5 19h-11A1.5 1.5 0 0 1 2 17.5z'), P('M16 9.5l6-3.5v12l-6-3.5')],
  videoOff: [P('M16 16v1.5A1.5 1.5 0 0 1 14.5 19h-11A1.5 1.5 0 0 1 2 17.5v-11A1.5 1.5 0 0 1 3.5 5H10'), P('M16 9.5l6-3.5v12l-2-1.2'), P('M3 3l18 18')],
  screen: [P('M2 4h20v12H2zM8 20h8M12 16v4')],
  record: [h('circle', { cx: 12, cy: 12, r: 6, fill: 'currentColor', stroke: 'none' })],
  stop: [h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: 'currentColor', stroke: 'none' })],
  pause: [P('M8 5v14M16 5v14')],
  play: [P('M7 4l13 8-13 8z', { fill: 'currentColor', stroke: 'none' })],
  // studio panels
  layers: [P('M12 2l9 5-9 5-9-5z'), P('M3 12l9 5 9-5M3 17l9 5 9-5')],
  users: [P('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), h('circle', { cx: 9, cy: 7, r: 4 }), P('M22 21v-2a4 4 0 0 0-3-3.9M16 3.1A4 4 0 0 1 16 11')],
  user: [P('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'), h('circle', { cx: 12, cy: 7, r: 4 })],
  chat: [P('M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5.2A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0z')],
  activity: [P('M22 12h-4l-3 9L9 3l-3 9H2')],
  signal: [P('M2 20h.01M7 20v-4M12 20v-8M17 20v-12M22 20V4')],
  gear: [h('circle', { cx: 12, cy: 12, r: 3 }), P('M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 0 1 4 0v.1A1.6 1.6 0 0 0 17 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z')],
  sparkles: [P('M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z'), P('M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z')],
  image: [h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }), h('circle', { cx: 8.5, cy: 8.5, r: 1.5 }), P('M21 15l-5-5L5 21')],
  bell: [P('M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'), P('M13.7 21a2 2 0 0 1-3.4 0')],
  keyboard: [h('rect', { x: 2, y: 5, width: 20, height: 14, rx: 2 }), P('M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8')],
  // generic
  maximize: [P('M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3')],
  more: [h('circle', { cx: 12, cy: 5, r: 1.6, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 12, cy: 19, r: 1.6, fill: 'currentColor', stroke: 'none' })],
  x: [P('M18 6L6 18M6 6l12 12')],
  check: [P('M20 6L9 17l-5-5')],
  search: [h('circle', { cx: 11, cy: 11, r: 7 }), P('M21 21l-4.3-4.3')],
  copy: [h('rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }), P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  link: [P('M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5')],
  chevronRight: [P('M9 18l6-6-6-6')],
  chevronDown: [P('M6 9l6 6 6-6')],
  chevronLeft: [P('M15 18l-6-6 6-6')],
  arrowRight: [P('M5 12h14M13 6l6 6-6 6')],
  arrowLeft: [P('M19 12H5M11 18l-6-6 6-6')],
  eye: [P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'), h('circle', { cx: 12, cy: 12, r: 3 })],
  volume: [P('M11 5L6 9H2v6h4l5 4z'), P('M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14')],
  volumeOff: [P('M11 5L6 9H2v6h4l5 4z'), P('M22 9l-6 6M16 9l6 6')],
  heart: [P('M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21.4l8.8-8.7a5 5 0 0 0 0-7.1z')],
  sun: [h('circle', { cx: 12, cy: 12, r: 4 }), P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')],
  moon: [P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z')],
  plus: [P('M12 5v14M5 12h14')],
  trash: [P('M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6')],
  edit: [P('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'), P('M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z')],
  refresh: [P('M21 2v6h-6M3 22v-6h6'), P('M21 8a9 9 0 0 0-15-3L3 8M3 16a9 9 0 0 0 15 3l3-3')],
  download: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3')],
  share: [h('circle', { cx: 18, cy: 5, r: 3 }), h('circle', { cx: 6, cy: 12, r: 3 }), h('circle', { cx: 18, cy: 19, r: 3 }), P('M8.6 13.5l6.8 4M15.4 6.5l-6.8 4')],
  calendar: [h('rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }), P('M3 10h18M8 2v4M16 2v4')],
  clock: [h('circle', { cx: 12, cy: 12, r: 9 }), P('M12 7v5l3 2')],
  star: [P('M12 2l3 6.5 7 .9-5 4.9 1.2 7L12 18l-6.4 3.3L7 15.3 2 10.4l7-.9z')],
  lock: [h('rect', { x: 4, y: 11, width: 16, height: 10, rx: 2 }), P('M8 11V7a4 4 0 0 1 8 0v4')],
  globe: [h('circle', { cx: 12, cy: 12, r: 9 }), P('M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z')],
  alert: [P('M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'), P('M12 9v4M12 17h.01')],
  info: [h('circle', { cx: 12, cy: 12, r: 9 }), P('M12 16v-4M12 8h.01')],
  wifi: [P('M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0'), h('circle', { cx: 12, cy: 19.5, r: 1, fill: 'currentColor', stroke: 'none' })],
  flag: [P('M4 22V4M4 4h13l-2 4 2 4H4')],
  flip: [P('M12 3v18M7 8L3 12l4 4M17 8l4 4-4 4')],
  send: [P('M22 2L11 13M22 2l-7 20-4-9-9-4z')],
  pin: [P('M12 2a6 6 0 0 0-6 6c0 4 6 12 6 12s6-8 6-12a6 6 0 0 0-6-6z'), h('circle', { cx: 12, cy: 8, r: 2 })],
  shield: [P('M12 2l8 4v5c0 5-3.5 9-8 11-4.5-2-8-6-8-11V6z'), P('M9 12l2 2 4-4')],
};

export interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 18, stroke = 1.7, className, style }: IconProps) {
  const inner = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {(inner || []).map((el, i) => React.cloneElement(el, { key: i }))}
    </svg>
  );
}

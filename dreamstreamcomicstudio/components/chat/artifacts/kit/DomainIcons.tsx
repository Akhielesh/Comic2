import React from 'react';

// Domain icon suite — a cohesive, dependency-free SVG line-icon set spanning the app's
// subjects (travel, finance, news, planning, places, weather, system). One 24×24
// viewBox, uniform 1.7 round stroke, `currentColor` throughout so a parent `text-…`
// or `style={{color}}` tints every mark and it adapts to light/dark for free. These
// are the house icons surfaced in the Gallery's Icons browser.

export interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

const Svg: React.FC<IconProps & { children: React.ReactNode; label: string }> = ({ size = 24, className = '', strokeWidth = 1.7, children, label }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label={label}
    style={{ display: 'inline-block', flexShrink: 0 }}
  >
    {children}
  </svg>
);

// ── Travel ──────────────────────────────────────────────────────────────────────
export const IconPlane: React.FC<IconProps> = (p) => (
  <Svg {...p} label="plane"><path d="M3 13.5 21 4l-4.5 16-4-7-7.5-1.5 2-1.5L5.5 9 3 13.5Z" /></Svg>
);
export const IconHotel: React.FC<IconProps> = (p) => (
  <Svg {...p} label="hotel"><path d="M3 20V6m0 9h18M21 20v-5a3 3 0 0 0-3-3H8v3" /><path d="M5.5 9.5h2" /></Svg>
);
export const IconRoute: React.FC<IconProps> = (p) => (
  <Svg {...p} label="route"><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M8 17c5-1 5-4 0-5s-5-4 0-5" strokeDasharray="0.1 3" /></Svg>
);
export const IconCompass: React.FC<IconProps> = (p) => (
  <Svg {...p} label="compass"><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></Svg>
);
export const IconLuggage: React.FC<IconProps> = (p) => (
  <Svg {...p} label="luggage"><rect x="5" y="7" width="14" height="13" rx="2.5" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M10 11v5M14 11v5" /></Svg>
);
export const IconBeach: React.FC<IconProps> = (p) => (
  <Svg {...p} label="beach"><path d="M12 21V9m0 0a6 6 0 0 1 9 3L12 9Zm0 0A6 6 0 0 0 3 12l9-3Z" /><path d="M8 21h8" /></Svg>
);
export const IconMountain: React.FC<IconProps> = (p) => (
  <Svg {...p} label="mountain"><path d="m3 19 6-11 4 6.5 2-3 6 7.5H3Z" /><path d="m9 8 1.6 2.6" /></Svg>
);
export const IconTicket: React.FC<IconProps> = (p) => (
  <Svg {...p} label="ticket"><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z" /><path d="M14 6v12" strokeDasharray="0.1 2.4" /></Svg>
);

// ── Finance ─────────────────────────────────────────────────────────────────────
export const IconTrendUp: React.FC<IconProps> = (p) => (
  <Svg {...p} label="trend up"><path d="M3 16.5 9 11l3.5 3L21 6" /><path d="M21 11V6h-5" /></Svg>
);
export const IconTrendDown: React.FC<IconProps> = (p) => (
  <Svg {...p} label="trend down"><path d="M3 7.5 9 13l3.5-3L21 18" /><path d="M21 13v5h-5" /></Svg>
);
export const IconCoins: React.FC<IconProps> = (p) => (
  <Svg {...p} label="coins"><ellipse cx="9" cy="7" rx="5" ry="2.5" /><path d="M4 7v5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7" /><path d="M14 12.5c2.6.2 5 1.2 5 2.6 0 1.4-2.2 2.4-5 2.4-1 0-2-.1-2.8-.4" /></Svg>
);
export const IconBank: React.FC<IconProps> = (p) => (
  <Svg {...p} label="bank"><path d="m3 9 9-5 9 5H3Z" /><path d="M5 9v8M10 9v8M14 9v8M19 9v8M3 20h18" /></Svg>
);
export const IconWallet: React.FC<IconProps> = (p) => (
  <Svg {...p} label="wallet"><path d="M3 7a2 2 0 0 1 2-2h12v3" /><rect x="3" y="7" width="18" height="12" rx="2.5" /><circle cx="16.5" cy="13" r="1.2" /></Svg>
);
export const IconCandles: React.FC<IconProps> = (p) => (
  <Svg {...p} label="candles"><path d="M7 4v3m0 7v3M7 7h0M7 14a2 2 0 0 1-2-2V9a2 2 0 0 1 4 0v3a2 2 0 0 1-2 2ZM17 7v2m0 8v3M17 17a2 2 0 0 1-2-2v-2a2 2 0 0 1 4 0v2a2 2 0 0 1-2 2Z" /></Svg>
);
export const IconPie: React.FC<IconProps> = (p) => (
  <Svg {...p} label="pie chart"><path d="M12 3a9 9 0 1 0 9 9h-9V3Z" /><path d="M14 3.5A7 7 0 0 1 20.5 10H14V3.5Z" /></Svg>
);
export const IconReceipt: React.FC<IconProps> = (p) => (
  <Svg {...p} label="receipt"><path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" /><path d="M9 8h6M9 12h6" /></Svg>
);

// ── News / media ──────────────────────────────────────────────────────────────────
export const IconNewspaper: React.FC<IconProps> = (p) => (
  <Svg {...p} label="newspaper"><path d="M4 5h12v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V5Z" /><path d="M16 9h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2M7 8h6M7 12h6M7 16h4" /></Svg>
);
export const IconBroadcast: React.FC<IconProps> = (p) => (
  <Svg {...p} label="broadcast"><circle cx="12" cy="12" r="2" /><path d="M7.5 7.5a6 6 0 0 0 0 9M16.5 16.5a6 6 0 0 0 0-9M4.5 4.5a10 10 0 0 0 0 15M19.5 19.5a10 10 0 0 0 0-15" /></Svg>
);
export const IconGlobe: React.FC<IconProps> = (p) => (
  <Svg {...p} label="globe"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></Svg>
);
export const IconMegaphone: React.FC<IconProps> = (p) => (
  <Svg {...p} label="megaphone"><path d="M4 10v4l2 .5V9.5L4 10Z" /><path d="m6 9.5 11-5v15l-11-5" /><path d="M8 15v3a1.5 1.5 0 0 0 3 0v-2.3" /></Svg>
);

// ── Planning / productivity ───────────────────────────────────────────────────────
export const IconCalendar: React.FC<IconProps> = (p) => (
  <Svg {...p} label="calendar"><rect x="4" y="5" width="16" height="16" rx="2.5" /><path d="M4 9.5h16M8 3v4M16 3v4" /><circle cx="9" cy="14" r=".6" fill="currentColor" /><circle cx="13" cy="14" r=".6" fill="currentColor" /></Svg>
);
export const IconChecklist: React.FC<IconProps> = (p) => (
  <Svg {...p} label="checklist"><rect x="5" y="4" width="14" height="17" rx="2.5" /><path d="M9 3.5h6v2H9zM8 11l1.5 1.5L12 10M8 16l1.5 1.5L12 15M15 11h1M15 16h1" /></Svg>
);
export const IconTarget: React.FC<IconProps> = (p) => (
  <Svg {...p} label="target"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></Svg>
);
export const IconClock: React.FC<IconProps> = (p) => (
  <Svg {...p} label="clock"><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></Svg>
);
export const IconFlag: React.FC<IconProps> = (p) => (
  <Svg {...p} label="flag"><path d="M5 21V4m0 1h11l-2 3 2 3H5" /></Svg>
);
export const IconBell: React.FC<IconProps> = (p) => (
  <Svg {...p} label="bell"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 19a2 2 0 0 0 4 0" /></Svg>
);

// ── Places / food / system ────────────────────────────────────────────────────────
export const IconFork: React.FC<IconProps> = (p) => (
  <Svg {...p} label="restaurant"><path d="M7 3v6a2 2 0 0 0 4 0V3M9 9v12M16 3c-1.5 0-2.5 2-2.5 5S15 13 16 13s2.5-2 2.5-5S17.5 3 16 3Zm0 10v8" /></Svg>
);
export const IconCoffee: React.FC<IconProps> = (p) => (
  <Svg {...p} label="coffee"><path d="M4 9h13v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z" /><path d="M17 10h2a2.5 2.5 0 0 1 0 5h-2M7 3.5v1.5M11 3.5v1.5" /></Svg>
);
export const IconBag: React.FC<IconProps> = (p) => (
  <Svg {...p} label="shopping"><path d="M5 8h14l-1 12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8Z" /><path d="M9 8a3 3 0 0 1 6 0" /></Svg>
);
export const IconPin: React.FC<IconProps> = (p) => (
  <Svg {...p} label="pin"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" /><circle cx="12" cy="10" r="2.5" /></Svg>
);

/** One catalog entry for the Gallery's Icons browser. */
export interface DomainIconDef {
  name: string;
  category: 'Travel' | 'Finance' | 'News' | 'Planning' | 'Places';
  keywords: string[];
  Icon: React.FC<IconProps>;
}

export const DOMAIN_ICONS: DomainIconDef[] = [
  { name: 'Plane', category: 'Travel', keywords: ['flight', 'fly', 'trip', 'airport', 'travel'], Icon: IconPlane },
  { name: 'Hotel', category: 'Travel', keywords: ['stay', 'bed', 'lodging', 'room'], Icon: IconHotel },
  { name: 'Route', category: 'Travel', keywords: ['directions', 'path', 'journey', 'navigate'], Icon: IconRoute },
  { name: 'Compass', category: 'Travel', keywords: ['explore', 'navigate', 'direction'], Icon: IconCompass },
  { name: 'Luggage', category: 'Travel', keywords: ['suitcase', 'bag', 'pack', 'trip'], Icon: IconLuggage },
  { name: 'Beach', category: 'Travel', keywords: ['vacation', 'holiday', 'sea', 'umbrella'], Icon: IconBeach },
  { name: 'Mountain', category: 'Travel', keywords: ['hike', 'peak', 'outdoor', 'nature'], Icon: IconMountain },
  { name: 'Ticket', category: 'Travel', keywords: ['booking', 'pass', 'event', 'admission'], Icon: IconTicket },
  { name: 'Trend up', category: 'Finance', keywords: ['gain', 'bull', 'growth', 'rise', 'stock'], Icon: IconTrendUp },
  { name: 'Trend down', category: 'Finance', keywords: ['loss', 'bear', 'fall', 'drop', 'stock'], Icon: IconTrendDown },
  { name: 'Coins', category: 'Finance', keywords: ['money', 'cash', 'crypto', 'savings'], Icon: IconCoins },
  { name: 'Bank', category: 'Finance', keywords: ['institution', 'finance', 'account'], Icon: IconBank },
  { name: 'Wallet', category: 'Finance', keywords: ['money', 'payment', 'budget'], Icon: IconWallet },
  { name: 'Candles', category: 'Finance', keywords: ['chart', 'trading', 'ohlc', 'market'], Icon: IconCandles },
  { name: 'Pie', category: 'Finance', keywords: ['allocation', 'portfolio', 'share', 'chart'], Icon: IconPie },
  { name: 'Receipt', category: 'Finance', keywords: ['expense', 'invoice', 'spend', 'bill'], Icon: IconReceipt },
  { name: 'Newspaper', category: 'News', keywords: ['article', 'headlines', 'press', 'read'], Icon: IconNewspaper },
  { name: 'Broadcast', category: 'News', keywords: ['live', 'signal', 'stream', 'feed'], Icon: IconBroadcast },
  { name: 'Globe', category: 'News', keywords: ['world', 'international', 'web', 'global'], Icon: IconGlobe },
  { name: 'Megaphone', category: 'News', keywords: ['announce', 'alert', 'promote'], Icon: IconMegaphone },
  { name: 'Calendar', category: 'Planning', keywords: ['schedule', 'date', 'event', 'agenda'], Icon: IconCalendar },
  { name: 'Checklist', category: 'Planning', keywords: ['todo', 'tasks', 'list', 'done'], Icon: IconChecklist },
  { name: 'Target', category: 'Planning', keywords: ['goal', 'aim', 'objective', 'focus'], Icon: IconTarget },
  { name: 'Clock', category: 'Planning', keywords: ['time', 'countdown', 'schedule'], Icon: IconClock },
  { name: 'Flag', category: 'Planning', keywords: ['milestone', 'goal', 'mark'], Icon: IconFlag },
  { name: 'Bell', category: 'Planning', keywords: ['alert', 'reminder', 'notify'], Icon: IconBell },
  { name: 'Restaurant', category: 'Places', keywords: ['food', 'dining', 'eat', 'fork'], Icon: IconFork },
  { name: 'Coffee', category: 'Places', keywords: ['cafe', 'drink', 'tea', 'break'], Icon: IconCoffee },
  { name: 'Shopping', category: 'Places', keywords: ['store', 'retail', 'buy', 'bag'], Icon: IconBag },
  { name: 'Pin', category: 'Places', keywords: ['location', 'map', 'place', 'marker'], Icon: IconPin }
];

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

// ── Tech ──────────────────────────────────────────────────────────────────────────
export const IconChip: React.FC<IconProps> = (p) => (
  <Svg {...p} label="chip"><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></Svg>
);
export const IconCode: React.FC<IconProps> = (p) => (
  <Svg {...p} label="code"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" /></Svg>
);
export const IconCloud: React.FC<IconProps> = (p) => (
  <Svg {...p} label="cloud"><path d="M7 18.5a4.2 4.2 0 0 1-.5-8.4 5.5 5.5 0 0 1 10.6-1.1A4.1 4.1 0 0 1 17 18.5H7Z" /></Svg>
);
export const IconDatabase: React.FC<IconProps> = (p) => (
  <Svg {...p} label="database"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></Svg>
);
export const IconRobot: React.FC<IconProps> = (p) => (
  <Svg {...p} label="robot"><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4.5v3.5M3 12v3M21 12v3M9.5 16h5" /><circle cx="12" cy="3.5" r="1.2" /><circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const IconRocket: React.FC<IconProps> = (p) => (
  <Svg {...p} label="rocket"><path d="M5 15c-1 1-1.4 4-1.4 4s3-.4 4-1.4M9.5 18.5A14 14 0 0 1 18 5.5C19.5 5 20 4 20 4s-1 .5-1.5 2A14 14 0 0 1 5.5 14.5" /><circle cx="14.5" cy="9.5" r="1.6" /></Svg>
);

// ── Health ────────────────────────────────────────────────────────────────────────
export const IconHeartPulse: React.FC<IconProps> = (p) => (
  <Svg {...p} label="health"><path d="M12 20S5 15.5 5 10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 1-.2 1.9-.6 2.8" /><path d="M7.5 11h2l1-1.6 1.6 3.2 1-1.6h3" /></Svg>
);
export const IconDumbbell: React.FC<IconProps> = (p) => (
  <Svg {...p} label="fitness"><path d="M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12" /></Svg>
);
export const IconLeaf: React.FC<IconProps> = (p) => (
  <Svg {...p} label="wellness"><path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14ZM5 19c2.5-4.5 5.5-7 9.5-9" /></Svg>
);
export const IconActivity: React.FC<IconProps> = (p) => (
  <Svg {...p} label="vitals"><path d="M3 12h4l2.5-7 4.5 14L17 12h4" /></Svg>
);

// ── Science ─────────────────────────────────────────────────────────────────────
export const IconFlask: React.FC<IconProps> = (p) => (
  <Svg {...p} label="flask"><path d="M9 3h6M10 3v6.5l-4.7 8.3A1.5 1.5 0 0 0 6.6 20h10.8a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3M7.5 14h9" /></Svg>
);
export const IconAtom: React.FC<IconProps> = (p) => (
  <Svg {...p} label="atom"><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><ellipse cx="12" cy="12" rx="9" ry="3.7" /><ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(120 12 12)" /></Svg>
);
export const IconDna: React.FC<IconProps> = (p) => (
  <Svg {...p} label="dna"><path d="M7 3c0 5 10 7 10 12s-10 4-10 9M17 3c0 5-10 7-10 12s10 4 10 9M8.5 7h7M8.5 17h7M10 5h4M10 19h4" /></Svg>
);

// ── Sports ──────────────────────────────────────────────────────────────────────
export const IconTrophy: React.FC<IconProps> = (p) => (
  <Svg {...p} label="trophy"><path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5.5a2.5 2.5 0 0 0 2.6 2.9M16 6h2.5A2.5 2.5 0 0 1 15.9 8.9M12 13v3M9 19h6l-.7-3H9.7L9 19Z" /></Svg>
);
export const IconMedal: React.FC<IconProps> = (p) => (
  <Svg {...p} label="medal"><circle cx="12" cy="15" r="5" /><path d="M9 3 7 8M15 3l2 5M11 3l1 4 1-4" /><path d="m12 13 .8 1.7 1.8.2-1.4 1.2.5 1.8L12 17l-1.7.9.5-1.8-1.4-1.2 1.8-.2L12 13Z" /></Svg>
);
export const IconBall: React.FC<IconProps> = (p) => (
  <Svg {...p} label="sports ball"><circle cx="12" cy="12" r="9" /><path d="m12 7.5 3 2.2-1.1 3.6h-3.8L9 9.7l3-2.2ZM12 7.5V3.2M15 9.7l3.6-2M13.9 13.3l1.8 3.6M10.1 13.3l-1.8 3.6M9 9.7 5.4 7.7" /></Svg>
);

// ── Entertainment ─────────────────────────────────────────────────────────────────
export const IconFilm: React.FC<IconProps> = (p) => (
  <Svg {...p} label="film"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7.5 5v14M16.5 5v14M3 9.5h4.5M3 14.5h4.5M16.5 9.5H21M16.5 14.5H21" /></Svg>
);
export const IconMusic: React.FC<IconProps> = (p) => (
  <Svg {...p} label="music"><path d="M9 18V6l11-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></Svg>
);
export const IconCamera: React.FC<IconProps> = (p) => (
  <Svg {...p} label="camera"><path d="M4 8h3l1.5-2.2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3.2" /></Svg>
);
export const IconHeadphones: React.FC<IconProps> = (p) => (
  <Svg {...p} label="headphones"><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M4 14a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2ZM20 14a2 2 0 0 0-2 2v2a2 2 0 0 0 4 0v-2a2 2 0 0 0-2-2Z" /></Svg>
);

// ── Communication ─────────────────────────────────────────────────────────────────
export const IconMail: React.FC<IconProps> = (p) => (
  <Svg {...p} label="mail"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></Svg>
);
export const IconChat: React.FC<IconProps> = (p) => (
  <Svg {...p} label="chat"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M8.5 10h7M8.5 13h4" /></Svg>
);
export const IconPhone: React.FC<IconProps> = (p) => (
  <Svg {...p} label="phone"><path d="M6 3h3l1.5 5-2 1.5a11 11 0 0 0 5 5l1.5-2 5 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4 5.2 2 2 0 0 1 6 3Z" /></Svg>
);
export const IconShare: React.FC<IconProps> = (p) => (
  <Svg {...p} label="share"><circle cx="6" cy="12" r="2.5" /><circle cx="17" cy="6" r="2.5" /><circle cx="17" cy="18" r="2.5" /><path d="m8.2 10.8 6.6-3.6M8.2 13.2l6.6 3.6" /></Svg>
);

// ── Tools / system ────────────────────────────────────────────────────────────────
export const IconSliders: React.FC<IconProps> = (p) => (
  <Svg {...p} label="settings"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="18" r="2" /></Svg>
);
export const IconWrench: React.FC<IconProps> = (p) => (
  <Svg {...p} label="tools"><path d="M14.7 6.3a4 4 0 0 0-5.4 4.6l-5.1 5.1a1.6 1.6 0 0 0 2.3 2.3l5.1-5.1a4 4 0 0 0 4.6-5.4l-2.3 2.3-1.5-1.5 2.3-2.3Z" /></Svg>
);
export const IconShield: React.FC<IconProps> = (p) => (
  <Svg {...p} label="security"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Svg>
);
export const IconKey: React.FC<IconProps> = (p) => (
  <Svg {...p} label="key"><circle cx="8" cy="8" r="4" /><path d="m10.8 10.8 8.2 8.2M16 16l2-2M19 19l1.5-1.5" /></Svg>
);
export const IconLink: React.FC<IconProps> = (p) => (
  <Svg {...p} label="link"><path d="m9 15 6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5" /></Svg>
);
export const IconSearch: React.FC<IconProps> = (p) => (
  <Svg {...p} label="search"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></Svg>
);

// ── Education ─────────────────────────────────────────────────────────────────────
export const IconBook: React.FC<IconProps> = (p) => (
  <Svg {...p} label="book"><path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2V5Z" /><path d="M5 18a2 2 0 0 0 2 2h12M9 7h6" /></Svg>
);
export const IconGradCap: React.FC<IconProps> = (p) => (
  <Svg {...p} label="education"><path d="m2 8 10-4 10 4-10 4L2 8Z" /><path d="M6 10v5c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5v-5M21 9v5" /></Svg>
);
export const IconPencil: React.FC<IconProps> = (p) => (
  <Svg {...p} label="write"><path d="m4 20 1-4L16 5l3 3L8 19l-4 1ZM14 7l3 3" /></Svg>
);
export const IconLightbulb: React.FC<IconProps> = (p) => (
  <Svg {...p} label="idea"><path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.8 10.6c.7.6 1.1 1.2 1.2 2.4h5.2c.1-1.2.5-1.8 1.2-2.4A6 6 0 0 0 12 3Z" /></Svg>
);

// ── Food ────────────────────────────────────────────────────────────────────────
export const IconPizza: React.FC<IconProps> = (p) => (
  <Svg {...p} label="pizza"><path d="M12 3 3 7c2 7 6 12 9 14 3-2 7-7 9-14L12 3Z" /><circle cx="10" cy="9.5" r="1" fill="currentColor" stroke="none" /><circle cx="13.5" cy="12.5" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const IconWine: React.FC<IconProps> = (p) => (
  <Svg {...p} label="drinks"><path d="M7 3h10l-1 5a4 4 0 0 1-8 0L7 3ZM12 13v6M9 21h6M6.5 8h11" /></Svg>
);
export const IconIceCream: React.FC<IconProps> = (p) => (
  <Svg {...p} label="dessert"><path d="M8 10a4 4 0 1 1 8 0M8 10h8l-4 10-4-10Z" /></Svg>
);

// ── Transit ─────────────────────────────────────────────────────────────────────
export const IconCar: React.FC<IconProps> = (p) => (
  <Svg {...p} label="car"><path d="m5 11 1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11M4 11h16v5H4zM5 16v2M19 16v2" /><circle cx="7.5" cy="13.5" r="1" fill="currentColor" stroke="none" /><circle cx="16.5" cy="13.5" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const IconTrain: React.FC<IconProps> = (p) => (
  <Svg {...p} label="train"><rect x="6" y="3" width="12" height="14" rx="3" /><path d="M6 11h12M9 3v8M15 3v8M8 21l2-3M16 21l-2-3" /><circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const IconBus: React.FC<IconProps> = (p) => (
  <Svg {...p} label="bus"><rect x="4" y="4" width="16" height="13" rx="2.5" /><path d="M4 11h16M8 4v7M16 4v7M6 21v-2M18 21v-2" /><circle cx="8" cy="14" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="14" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const IconBike: React.FC<IconProps> = (p) => (
  <Svg {...p} label="bike"><circle cx="6" cy="17" r="3.2" /><circle cx="18" cy="17" r="3.2" /><path d="M6 17l4-7h5M9 7h3.5l3 10M14.5 10H18" /></Svg>
);

// ── Crypto ────────────────────────────────────────────────────────────────────────
export const IconBitcoin: React.FC<IconProps> = (p) => (
  <Svg {...p} label="bitcoin"><circle cx="12" cy="12" r="9" /><path d="M10 8h3.3a2 2 0 0 1 0 4H10m0 0h3.7a2 2 0 0 1 0 4H10m0-8V6.5m0 9.5V18m2-12v2m0 8v2M9 8v8" /></Svg>
);
export const IconBlockchain: React.FC<IconProps> = (p) => (
  <Svg {...p} label="blockchain"><rect x="3" y="9" width="6" height="6" rx="1.2" /><rect x="15" y="9" width="6" height="6" rx="1.2" /><rect x="9" y="3" width="6" height="6" rx="1.2" /><rect x="9" y="15" width="6" height="6" rx="1.2" /><path d="M9 12H6.5M17.5 12H15M12 9V6.5M12 17.5V15" /></Svg>
);

// ── Nature ────────────────────────────────────────────────────────────────────────
export const IconTree: React.FC<IconProps> = (p) => (
  <Svg {...p} label="tree"><path d="M12 21v-5M8 16h8l-3-4h2l-3-4h1.6L12 3.5 8.8 8H10.4l-3 4H9l-1 4Z" /></Svg>
);
export const IconDroplet: React.FC<IconProps> = (p) => (
  <Svg {...p} label="water"><path d="M12 3.5s6 6.3 6 10.5a6 6 0 0 1-12 0c0-4.2 6-10.5 6-10.5Z" /></Svg>
);
export const IconFire: React.FC<IconProps> = (p) => (
  <Svg {...p} label="fire"><path d="M12 3c.6 3.2 3.2 4.3 3.2 7.8A3.2 3.2 0 0 1 12 14a3.2 3.2 0 0 1-3.2-3.2c0-1 .3-1.8.8-2.6C10 9.6 9 11 9 12.6a3 3 0 0 0 6 0M12 21a6 6 0 0 0 6-6c0-1.4-.4-2.7-1-3.8" /></Svg>
);

// ── Commerce ──────────────────────────────────────────────────────────────────────
export const IconCart: React.FC<IconProps> = (p) => (
  <Svg {...p} label="cart"><path d="M3 4h2l2.2 11.2A1.5 1.5 0 0 0 8.7 16.4H18l2-8H6.2" /><circle cx="9.5" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /></Svg>
);
export const IconGift: React.FC<IconProps> = (p) => (
  <Svg {...p} label="gift"><rect x="3.5" y="8" width="17" height="4.5" rx="1" /><path d="M5 12.5V20h14v-7.5M12 8v12M12 8S10.5 3 8 4.5 9.5 8 12 8ZM12 8s1.5-5 4-3.5S14.5 8 12 8Z" /></Svg>
);
export const IconTag: React.FC<IconProps> = (p) => (
  <Svg {...p} label="tag"><path d="M3 12V4h8l9 9-7 7-9-9Z" /><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none" /></Svg>
);
export const IconPercent: React.FC<IconProps> = (p) => (
  <Svg {...p} label="discount"><path d="m6 18 12-12" /><circle cx="7.5" cy="7.5" r="2" /><circle cx="16.5" cy="16.5" r="2" /></Svg>
);

// ── Extra (existing categories) ─────────────────────────────────────────────────────
export const IconHome: React.FC<IconProps> = (p) => (
  <Svg {...p} label="home"><path d="m3 11 9-7 9 7M5 9.5V20h14V9.5M9.5 20v-6h5v6" /></Svg>
);
export const IconStar: React.FC<IconProps> = (p) => (
  <Svg {...p} label="star"><path d="m12 3 2.6 5.4 6 .8-4.3 4.2 1 6L12 16.6 6.7 19.4l1-6-4.3-4.2 6-.8L12 3Z" /></Svg>
);

/** One catalog entry for the Gallery's Icons browser. */
export interface DomainIconDef {
  name: string;
  category: 'Travel' | 'Finance' | 'News' | 'Planning' | 'Places' | 'Tech' | 'Health' | 'Science' | 'Sports' | 'Media' | 'Tools' | 'Education' | 'Food' | 'Transit' | 'Crypto' | 'Nature' | 'Commerce';
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
  { name: 'Pin', category: 'Places', keywords: ['location', 'map', 'place', 'marker'], Icon: IconPin },
  { name: 'Chip', category: 'Tech', keywords: ['cpu', 'processor', 'hardware', 'compute'], Icon: IconChip },
  { name: 'Code', category: 'Tech', keywords: ['dev', 'programming', 'brackets', 'software'], Icon: IconCode },
  { name: 'Cloud', category: 'Tech', keywords: ['server', 'hosting', 'sync', 'storage'], Icon: IconCloud },
  { name: 'Database', category: 'Tech', keywords: ['data', 'store', 'sql', 'records'], Icon: IconDatabase },
  { name: 'Robot', category: 'Tech', keywords: ['ai', 'bot', 'agent', 'automation'], Icon: IconRobot },
  { name: 'Rocket', category: 'Tech', keywords: ['launch', 'startup', 'ship', 'fast'], Icon: IconRocket },
  { name: 'Health', category: 'Health', keywords: ['heart', 'pulse', 'medical', 'vitals'], Icon: IconHeartPulse },
  { name: 'Fitness', category: 'Health', keywords: ['gym', 'workout', 'weights', 'exercise'], Icon: IconDumbbell },
  { name: 'Wellness', category: 'Health', keywords: ['leaf', 'nature', 'calm', 'eco'], Icon: IconLeaf },
  { name: 'Vitals', category: 'Health', keywords: ['activity', 'heartbeat', 'monitor', 'pulse'], Icon: IconActivity },
  { name: 'Flask', category: 'Science', keywords: ['lab', 'chemistry', 'experiment', 'research'], Icon: IconFlask },
  { name: 'Atom', category: 'Science', keywords: ['physics', 'nuclear', 'particle', 'science'], Icon: IconAtom },
  { name: 'DNA', category: 'Science', keywords: ['biology', 'genetics', 'helix', 'health'], Icon: IconDna },
  { name: 'Trophy', category: 'Sports', keywords: ['win', 'champion', 'award', 'first'], Icon: IconTrophy },
  { name: 'Medal', category: 'Sports', keywords: ['award', 'rank', 'achievement', 'win'], Icon: IconMedal },
  { name: 'Ball', category: 'Sports', keywords: ['soccer', 'football', 'game', 'play'], Icon: IconBall },
  { name: 'Film', category: 'Media', keywords: ['movie', 'video', 'cinema', 'watch'], Icon: IconFilm },
  { name: 'Music', category: 'Media', keywords: ['song', 'audio', 'track', 'play'], Icon: IconMusic },
  { name: 'Camera', category: 'Media', keywords: ['photo', 'picture', 'shoot', 'lens'], Icon: IconCamera },
  { name: 'Headphones', category: 'Media', keywords: ['audio', 'podcast', 'listen', 'sound'], Icon: IconHeadphones },
  { name: 'Mail', category: 'Media', keywords: ['email', 'message', 'inbox', 'send'], Icon: IconMail },
  { name: 'Chat', category: 'Media', keywords: ['message', 'talk', 'comment', 'reply'], Icon: IconChat },
  { name: 'Phone', category: 'Media', keywords: ['call', 'contact', 'telephone', 'dial'], Icon: IconPhone },
  { name: 'Share', category: 'Media', keywords: ['network', 'send', 'connect', 'distribute'], Icon: IconShare },
  { name: 'Settings', category: 'Tools', keywords: ['controls', 'sliders', 'config', 'preferences'], Icon: IconSliders },
  { name: 'Wrench', category: 'Tools', keywords: ['tools', 'fix', 'repair', 'build'], Icon: IconWrench },
  { name: 'Shield', category: 'Tools', keywords: ['security', 'protect', 'safe', 'privacy'], Icon: IconShield },
  { name: 'Key', category: 'Tools', keywords: ['access', 'auth', 'password', 'secret'], Icon: IconKey },
  { name: 'Link', category: 'Tools', keywords: ['url', 'chain', 'connect', 'hyperlink'], Icon: IconLink },
  { name: 'Search', category: 'Tools', keywords: ['find', 'magnify', 'lookup', 'query'], Icon: IconSearch },
  { name: 'Book', category: 'Education', keywords: ['read', 'learn', 'guide', 'docs'], Icon: IconBook },
  { name: 'Grad cap', category: 'Education', keywords: ['school', 'study', 'degree', 'learn'], Icon: IconGradCap },
  { name: 'Pencil', category: 'Education', keywords: ['write', 'edit', 'note', 'draw'], Icon: IconPencil },
  { name: 'Idea', category: 'Education', keywords: ['lightbulb', 'insight', 'tip', 'inspiration'], Icon: IconLightbulb },
  { name: 'Pizza', category: 'Food', keywords: ['restaurant', 'dining', 'slice', 'italian'], Icon: IconPizza },
  { name: 'Drinks', category: 'Food', keywords: ['wine', 'bar', 'glass', 'beverage'], Icon: IconWine },
  { name: 'Dessert', category: 'Food', keywords: ['ice cream', 'sweet', 'treat', 'cone'], Icon: IconIceCream },
  { name: 'Car', category: 'Transit', keywords: ['drive', 'auto', 'vehicle', 'rental'], Icon: IconCar },
  { name: 'Train', category: 'Transit', keywords: ['rail', 'metro', 'subway', 'commute'], Icon: IconTrain },
  { name: 'Bus', category: 'Transit', keywords: ['transit', 'coach', 'public', 'commute'], Icon: IconBus },
  { name: 'Bike', category: 'Transit', keywords: ['cycle', 'bicycle', 'ride', 'eco'], Icon: IconBike },
  { name: 'Bitcoin', category: 'Crypto', keywords: ['btc', 'coin', 'token', 'currency'], Icon: IconBitcoin },
  { name: 'Blockchain', category: 'Crypto', keywords: ['blocks', 'web3', 'ledger', 'chain'], Icon: IconBlockchain },
  { name: 'Tree', category: 'Nature', keywords: ['forest', 'park', 'eco', 'plant'], Icon: IconTree },
  { name: 'Water', category: 'Nature', keywords: ['droplet', 'rain', 'liquid', 'hydration'], Icon: IconDroplet },
  { name: 'Fire', category: 'Nature', keywords: ['flame', 'hot', 'trending', 'streak'], Icon: IconFire },
  { name: 'Cart', category: 'Commerce', keywords: ['shop', 'buy', 'checkout', 'store'], Icon: IconCart },
  { name: 'Gift', category: 'Commerce', keywords: ['present', 'reward', 'box', 'offer'], Icon: IconGift },
  { name: 'Tag', category: 'Commerce', keywords: ['price', 'label', 'sale', 'category'], Icon: IconTag },
  { name: 'Discount', category: 'Commerce', keywords: ['percent', 'sale', 'deal', 'off'], Icon: IconPercent },
  { name: 'Home', category: 'Places', keywords: ['house', 'address', 'main', 'dashboard'], Icon: IconHome },
  { name: 'Star', category: 'Planning', keywords: ['favorite', 'rating', 'bookmark', 'priority'], Icon: IconStar }
];

/**
 * The `ds` colour namespace (bridge D6; docs/design/design-system.md "Named ds colours"): every `--ds-*`
 * colour token as a named Tailwind colour, so `bg-ds-canvas`, `text-ds-muted`, `border-ds-hairline` read the
 * theme and the skin, and a slash opacity is legal: `text-ds-ink/60` is `color-mix(in srgb, var(--ds-ink)
 * 60%, transparent)` (a slash on a bare `var()` arbitrary value is invalid CSS). tests/config/dsColours.test.ts
 * keeps this list equal to index.css's colour tokens and compiles a probe.
 */
const withOpacity = (v) => ({ opacityValue }) =>
  opacityValue === undefined ? `var(${v})` : `color-mix(in srgb, var(${v}) calc(${opacityValue} * 100%), transparent)`;
const DS_COLOURS = [
  'canvas', 'sidebar', 'surface', 'surface-soft', 'surface-strong', 'raised', 'ink', 'muted',
  'hairline', 'hairline-soft', 'well', 'well-strong', 'hover', 'faint', 'active',
  'accent', 'accent-hover', 'accent-text', 'accent-fill', 'accent-fill-hover', 'on-accent', 'accent-soft',
  'success', 'success-text', 'warning', 'warning-text', 'danger', 'danger-text', 'danger-mark', 'on-danger', 'info', 'info-text',
  'ring', 'focus', 'control-border', 'control-border-hover', 'overlay-edge', 'overlay-hover', 'scrim',
  'skeleton', 'skeleton-glint', 'segment-pill', 'segment-track', 'status-error-edge', 'status-error-tint', 'toast-edge',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'grid-dot', 'spot-ink',
  // The colour layer "Ink & Spark" (docs/design/design-system.md § Colour layer; tests/config/sparkGuard.test.ts
  // holds every spark fill, `bg-ds-spark` included, to its allowlist).
  'spark', 'spark-hover', 'on-spark', 'spark-text', 'spark-soft', 'spark-glow',
  'hue-1', 'hue-2', 'hue-3', 'hue-4', 'hue-5', 'art',
  // The colour layer "Ink, Paper & Colour" (CL-6): hues 6 and 7, each hue's readable text step, opaque soft tint and
  // solid fill, the one label colour on a solid, the sequential and diverging chart ramps, and the studio accent.
  'hue-6', 'hue-7',
  'hue-1-text', 'hue-2-text', 'hue-3-text', 'hue-4-text', 'hue-5-text', 'hue-6-text', 'hue-7-text',
  'hue-1-soft', 'hue-2-soft', 'hue-3-soft', 'hue-4-soft', 'hue-5-soft', 'hue-6-soft', 'hue-7-soft',
  'hue-1-solid', 'hue-2-solid', 'hue-3-solid', 'hue-4-solid', 'hue-5-solid', 'hue-6-solid', 'hue-7-solid', 'on-hue',
  'chart-seq-1', 'chart-seq-2', 'chart-seq-3', 'chart-seq-4', 'chart-seq-5', 'chart-seq-6',
  'chart-div-1', 'chart-div-2', 'chart-div-3', 'chart-div-4', 'chart-div-5', 'chart-div-6', 'chart-div-7',
  'studio', 'studio-soft', 'art-soft', 'art-edge',
  // The art develop (MO-1): read by inline styles in ImageDevelop; listed because every colour token is.
  'develop-light', 'develop-sheen',
  'reader-room', 'reader-paper-back', 'reader-endpaper', 'reader-focus'
];
const dsColours = Object.fromEntries(DS_COLOURS.map((name) => [name, withOpacity(`--ds-${name}`)]));

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./index.html",
    "./App.tsx",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./services/**/*.{ts,tsx}",
    "./qa/**/*.{ts,tsx,html}",
    "./public/**/*.html"
  ],
  theme: {
    // Ordered screens (Comic Studio v5, contract §13.5). Tailwind v3 emits min-width
    // screens in CONFIG ORDER, so the whole map is replaced rather than extended: an
    // `extend` would append `medium:` (600) after `xl:` and break the cascade. The
    // default sm/md/lg/xl/2xl values are kept, so no existing class changes meaning.
    // The Material window classes slot in between: medium 600, expanded 840,
    // large 1200, xlarge 1600. Raw queries cover height, pointer, hover, foldables and
    // installed-PWA mode.
    // NOTE: object (raw) screens disable Tailwind's `max-*`/`min-*` breakpoint
    // variants (they throw if used). Use the named screens or raw ones instead.
    screens: {
      medium: "600px",
      sm: "640px",
      md: "768px",
      expanded: "840px",
      lg: "1024px",
      large: "1200px",
      xl: "1280px",
      "2xl": "1536px",
      xlarge: "1600px",
      "compact-h": { raw: "(max-height: 479px)" },
      coarse: { raw: "(pointer: coarse)" },
      fine: { raw: "(pointer: fine)" },
      "can-hover": { raw: "(hover: hover) and (pointer: fine)" },
      dual: { raw: "(horizontal-viewport-segments: 2)" },
      standalone: { raw: "(display-mode: standalone)" }
    },
    // `.container` keeps the Tailwind default breakpoints so the new window classes
    // above never add max-width steps to existing containers.
    container: {
      screens: { sm: "640px", md: "768px", lg: "1024px", xl: "1280px", "2xl": "1536px" }
    },
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        comic: ["Comic Neue", "cursive"],
        display: ["Bangers", "cursive"]
      },
      colors: {
        ds: dsColours,
        brand: {
          yellow: "#FACC15",
          blue: "#3B82F6",
          red: "#EF4444",
          black: "#18181b"
        }
      },
      boxShadow: {
        comic: "4px 4px 0px 0px #000000",
        "comic-hover": "2px 2px 0px 0px #000000"
      }
    }
  },
  plugins: []
};

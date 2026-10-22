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

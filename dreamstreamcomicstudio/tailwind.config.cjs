/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./studio.html",
    "./App.tsx",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./services/**/*.{ts,tsx}",
    "./studio/**/*.{ts,tsx}",
    "./public/**/*.html"
  ],
  theme: {
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
        },
        // Dark "studio" workspace surface (Code Studio). Mirrors components/studio/kit/theme.ts.
        studio: {
          bg: "#0b0e14",
          panel: "#11151f",
          panelAlt: "#0e1219",
          edge: "#1c2433",
          accent: "#38bdf8"
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

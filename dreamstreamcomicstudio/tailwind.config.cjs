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

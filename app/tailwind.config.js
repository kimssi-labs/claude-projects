/**
 * The palette is defined ONCE as CSS variables (see index.css) and mapped here, so every existing
 * class — bg-ink-800, text-bone-400 — follows the light/dark switch without being rewritten.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  darkMode: ["class", '[data-theme="dark"]'],
  // Every file with markup in it. A feature's page side lives beside its main side, outside the
  // renderer folder; leaving it out here built a stylesheet without the classes it uses — the
  // band's resize grip became a 0 × 0 element that could not be grabbed.
  content: ["./src/renderer/**/*.{html,ts,tsx}", "./src/features/**/ui.tsx"],
  theme: {
    extend: {
      colors: {
        ink: {
          900: token("surface"),      // the page itself
          800: token("panel"),        // cards, sidebars, the status strip
          700: token("raised"),       // rows, inputs, buttons
          600: token("line"),         // borders
          500: token("faint"),        // dividers that must still be visible
        },
        bone: {
          100: token("text"),
          200: token("text"),
          300: token("muted"),
          400: token("muted"),
          500: token("faint"),
        },
        accent: { DEFAULT: "#d97757", soft: "#e69c81", dim: "#8a4b34" },
        ok: "#3f9f61",
        warn: "#c08a1e",
        bad: "#cf4a38",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["D2Coding", "Cascadia Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

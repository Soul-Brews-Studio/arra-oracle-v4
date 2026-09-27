/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // #33 AC2 (ui-keys): a landscape phone (812x375) is below `lg` but too
      // short for the stacked layout's viewport-pinned shell -- see App.tsx.
      screens: { short: { raw: "(max-height: 500px) and (max-width: 1023.98px)" } },
      colors: {
        // Project design rules (CLAUDE.md): bg #0a0a0f, accent #64b5f6.
        // Text never dimmer than #8b93a7 -- #777 and below fails on this bg.
        ink: "#0a0a0f",
        panel: "#12121a",
        edge: "#23232f",
        accent: "#64b5f6",
        muted: "#8b93a7",
      },
    },
  },
  plugins: [],
};

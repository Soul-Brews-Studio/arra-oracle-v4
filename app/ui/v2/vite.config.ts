import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// POC dev server. `/api` is proxied to the real Bun server so the UI talks to
// live endpoints rather than fixtures -- the whole point of this spike.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    proxy: {
      "/api": { target: "http://127.0.0.1:3939", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:3939", changeOrigin: true },
    },
  },
});

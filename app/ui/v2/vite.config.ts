import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// POC dev server. `/api` is proxied to the real Bun server so the UI talks to
// live endpoints rather than fixtures -- the whole point of this spike.
// `base` and `outDir` exist because of the server's Host/Origin gate, which
// is worth understanding before changing them. The server derives BOTH the
// expected Host and the expected Origin from one `ARRA_ORIGIN` value and
// enforces them on every route, public ones included (auth/http.ts:43-44).
//
// A browser on the vite port can never satisfy both: it sends `Origin:
// 127.0.0.1:5175`, and `changeOrigin` rewrites Host to `127.0.0.1:3939`. One
// of the two always mismatches -- pointing ARRA_ORIGIN at 5175 just moves the
// failure from a 403 on Origin to a 400 on Host. That is the gate working,
// not a misconfiguration: it is DNS-rebinding protection.
//
// So the real answer is SAME ORIGIN. `bun run build` emits into the server's
// own static assets directory, and the app is served from
// http://127.0.0.1:3939/v2/ where both checks pass by construction. `bun run
// dev` on 5175 stays useful for layout work, where a 403 on /api is expected.
export default defineConfig({
  base: "/v2/",
  build: { outDir: "../../server/public/v2", emptyOutDir: true },
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

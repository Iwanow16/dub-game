import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.API_URL ?? "http://localhost:3000";
const game = process.env.GAME_URL ?? "http://localhost:3001";

// Dev proxy mirrors the Caddy routing in production (§21.2).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api/rooms": game,
      "/api/game": game,
      "/ws": { target: game.replace(/^http/, "ws"), ws: true },
      "/api": api,
      "/media": api,
      "/help": { target: "http://localhost:5175", rewrite: (p) => p },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});

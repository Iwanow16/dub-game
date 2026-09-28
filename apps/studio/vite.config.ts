import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, host: true, proxy: { "/api": api, "/media": api } },
  build: { target: "es2022", sourcemap: true },
});

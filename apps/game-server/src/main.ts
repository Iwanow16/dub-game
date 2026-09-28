import { parseKeys } from "@dubroom/shared/token";
import { GameServer, cachedCatalog } from "./server.ts";

const log = (msg: string, extra: object = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "game-server", msg, ...extra }),
  );

const server = new GameServer({
  signingKeys: parseKeys(process.env.TOKEN_SIGNING_KEY),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  trustCfIp: process.env.TRUST_CF_CONNECTING_IP === "true",
  catalog: cachedCatalog(process.env.API_INTERNAL_URL ?? "http://localhost:3000"),
  maxRooms: Number(process.env.MAX_ROOMS ?? 500),
  roomIdleMs: Number(process.env.ROOM_IDLE_HOURS ?? 2) * 3600_000,
  log,
});

const port = Number(process.env.GAME_PORT ?? 3001);
await server.listen(port, process.env.GAME_HOST ?? "0.0.0.0");
log("listening", { port });

/**
 * Graceful stop (§21.4 stop.sh): stop accepting new rooms, let running rounds finish for up to
 * DRAIN_SECONDS, then close.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  server.draining = true;
  const drainMs = Number(process.env.DRAIN_SECONDS ?? 0) * 1000;
  log("shutting down", { signal, drainMs });
  const deadline = Date.now() + drainMs;
  while (Date.now() < deadline) {
    const busy = [...server.rooms.values()].some((r) => r.phase !== "lobby" && r.phase !== "final");
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await server.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Db } from "@dubroom/db";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const db = new Db(config.dbPath);
const app = await buildApp(config, db);

/** Dubs live 24 h (§11.6, §14): purge expired files hourly. */
async function purgeDubs() {
  for (const rel of db.takeExpiredDubs()) {
    await rm(join(config.dataDir, rel), { force: true }).catch(() => {});
  }
}
const purgeTimer = setInterval(() => void purgeDubs(), 3600_000);
void purgeDubs();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  clearInterval(purgeTimer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: config.host });

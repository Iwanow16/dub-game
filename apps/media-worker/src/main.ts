import { join, resolve } from "node:path";
import { Db } from "@dubroom/db";
import { runWorker } from "./worker.ts";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const db = new Db(process.env.DB_PATH ?? join(dataDir, "db", "dubroom.sqlite"));
const controller = new AbortController();

const log = (msg: string, extra: object = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "media-worker", msg, ...extra }),
  );

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log("shutting down", { signal: sig });
    controller.abort();
  });
}

log("started", { dataDir });
await runWorker(db, {
  dataDir,
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MIN ?? 10) * 60_000,
  pollMs: Number(process.env.POLL_MS ?? 2000),
  signal: controller.signal,
  log,
});
db.close();

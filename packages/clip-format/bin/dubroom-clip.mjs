#!/usr/bin/env node
// Thin launcher: run the TypeScript CLI through tsx so the package needs no build step.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const r = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);

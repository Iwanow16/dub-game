// Bundles a Node service: workspace packages (TypeScript sources) and their dependencies are
// inlined; only the service's *direct* npm dependencies stay external — they are installed in
// the runtime image by `pnpm deploy`.
//   node tools/build-node.mjs [entry …] [--outfile=dist/x.js] [--standalone]
//   --standalone inlines npm dependencies too (single-file CLI)
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outfile = args.find((a) => a.startsWith("--outfile="))?.slice(10);
const entries = args.filter((a) => !a.startsWith("--"));

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const standalone = args.includes("--standalone");
const external = Object.entries(standalone ? {} : (pkg.dependencies ?? {}))
  .filter(([, spec]) => !String(spec).startsWith("workspace:"))
  .map(([name]) => name);

await build({
  entryPoints: entries.length ? entries : ["src/main.ts"],
  ...(outfile ? { outfile } : { outdir: "dist" }),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: external.flatMap((n) => [n, `${n}/*`]),
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

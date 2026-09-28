// Bundles a Node service: workspace packages (TypeScript sources) are inlined,
// npm dependencies stay external and are installed in the runtime image.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
const external = new Set();
const collect = (deps = {}, dir) => {
  for (const [name, spec] of Object.entries(deps)) {
    if (String(spec).startsWith("workspace:")) {
      const wsDir = join(dir, "node_modules", name);
      const wsPkg = JSON.parse(readFileSync(join(wsDir, "package.json"), "utf8"));
      collect(wsPkg.dependencies, wsDir);
    } else {
      external.add(name);
    }
  }
};
collect(pkg.dependencies, cwd);

await build({
  entryPoints: process.argv.slice(2).length ? process.argv.slice(2) : ["src/main.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [...external].flatMap((n) => [n, `${n}/*`]),
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

// Builds the /help site from docs/user/*.md (§23.4) and checks links (§23.5):
//   node build.mjs          → dist/
//   node build.mjs --check  → build + verify every /help/… link used by the apps and docs exists
//   node build.mjs --watch  → rebuild on change and serve on :5175 (dev)
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const src = join(root, "docs/user");
const out = join(here, "dist");

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

function page(title, body, lang, nav) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · DubRoom</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>${readFileSync(join(root, "packages/ui/src/tokens.css"), "utf8")}
body{max-width:860px;margin:0 auto;padding:16px 20px 64px}
nav.help{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;align-items:center}
nav.help a{padding:6px 12px;border-radius:8px;background:var(--surface-2);color:var(--text);text-decoration:none}
nav.help a.cur{background:var(--accent);color:var(--accent-ink)}
nav.help .home{font:700 1.1rem var(--font-display);background:none;padding-left:0}
main h2{margin-top:32px} main h3{margin-top:24px}
code{background:var(--surface-2);padding:1px 5px;border-radius:4px}
pre{background:var(--surface);padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
blockquote{border-left:4px solid var(--accent);margin:0;padding:4px 16px;background:var(--surface)}
</style>
</head>
<body>
<nav class="help"><a class="home" href="/">🎬 DubRoom</a>${nav}</nav>
<main>${body}</main>
</body>
</html>`;
}

function renderer() {
  const r = new marked.Renderer();
  // "## Title {#custom-id}" gives a stable anchor independent of the language
  r.heading = ({ tokens, depth }) => {
    let text = marked.Parser.parseInline(tokens);
    let id = slug(text);
    const custom = /\s*\{#([\w-]+)\}\s*$/.exec(text);
    if (custom) {
      id = custom[1];
      text = text.slice(0, custom.index);
    }
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };
  return r;
}

function collect(dir) {
  return readdirSync(dir)
    .filter((f) => extname(f) === ".md")
    .map((f) => join(dir, f));
}

export function build() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const sets = [
    { lang: "ru", dir: src, base: "/help/" },
    { lang: "en", dir: join(src, "en"), base: "/help/en/" },
  ];
  const anchors = new Map();
  for (const set of sets) {
    if (!existsSync(set.dir)) continue;
    const files = collect(set.dir).sort((a, b) =>
      a.endsWith("index.md") ? -1 : b.endsWith("index.md") ? 1 : a.localeCompare(b),
    );
    const docs = files.map((f) => {
      const md = readFileSync(f, "utf8");
      const name = f.split("/").pop().replace(/\.md$/, "");
      const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? name;
      return { name, title, md };
    });
    for (const d of docs) {
      const nav = docs
        .map(
          (x) =>
            `<a href="${set.base}${x.name === "index" ? "" : `${x.name}.html`}"${x.name === d.name ? ' class="cur"' : ""}>${x.title.replace(/^[^\p{L}]+/u, "")}</a>`,
        )
        .join("")
        .concat(set.lang === "ru" ? `<a href="/help/en/">EN</a>` : `<a href="/help/">RU</a>`);
      // relative .md links → .html
      const md = d.md.replace(
        /\]\(([\w-]+)\.md(#[^)]*)?\)/g,
        (_, n, h = "") => `](${n === "index" ? "./" : `${n}.html`}${h})`,
      );
      const html = marked.parse(md, { renderer: renderer() });
      const dir = set.lang === "ru" ? out : join(out, "en");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, d.name === "index" ? "index.html" : `${d.name}.html`);
      writeFileSync(file, page(d.title, html, set.lang, nav));
      anchors.set(
        relative(out, file),
        new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])),
      );
    }
  }
  return anchors;
}

/** §23.5: every /help/… link in the apps and docs must point to an existing page and anchor. */
function check(anchors) {
  const scan = [join(root, "apps/web/src"), join(root, "apps/studio/src"), out];
  const problems = [];
  const walk = (d) =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const dir of scan) {
    for (const file of walk(dir).filter((f) => /\.(tsx?|html)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'(]\/help\/([^"'#)\s]*)(#[^"')\s]+)?/g)) {
        let target = m[1] || "index.html";
        if (target.endsWith("/")) target += "index.html";
        const anchor = m[2]?.slice(1);
        const ids = anchors.get(target);
        if (!ids) problems.push(`${relative(root, file)}: /help/${m[1]} — нет такой страницы`);
        else if (anchor && !ids.has(decodeURIComponent(anchor)))
          problems.push(`${relative(root, file)}: /help/${m[1]}#${anchor} — нет такого раздела`);
      }
    }
  }
  return problems;
}

const args = process.argv.slice(2);
const anchors = build();
console.log(`help: ${anchors.size} pages → ${relative(root, out)}`);
if (args.includes("--check")) {
  const problems = check(anchors);
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ links ok");
}
if (args.includes("--watch")) {
  watch(src, { recursive: true }, () => {
    try {
      build();
      console.log("help: rebuilt");
    } catch (e) {
      console.error(e);
    }
  });
  createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/help/, "") || "/";
    if (p.endsWith("/")) p += "index.html";
    const f = join(out, p);
    if (!f.startsWith(out) || !existsSync(f)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(f));
  }).listen(5175, () => console.log("help: http://localhost:5175/help/"));
}

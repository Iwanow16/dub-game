import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPackage, BuildError } from "./build.ts";
import { probe, run } from "./ffmpeg.ts";
import { emptyManifest, ROLE_COLORS, type ClipManifest } from "./manifest.ts";
import { publishPackage } from "./publish.ts";
import { linesFromSrt, parseSrt } from "./subtitles.ts";
import { synthesizeSource, type SynthRecipe } from "./synth.ts";
import { validateManifest, type Issue } from "./validate.ts";

const HELP = `dubroom-clip — работа с пакетами клипов DubRoom (§9.4)

Использование:
  dubroom-clip init <dir> --video <file> [--bed <file>] [--dialogue <file>] [--title <t>] [--slug <s>]
  dubroom-clip synth <dir>                 сгенерировать демо-исходник по manifest.json (+ synth.json)
  dubroom-clip separate <dir>              отделить голос от фона (нужен demucs)
  dubroom-clip lines <dir> --from-srt <file> [--role-map roles.json] [--lang ru|en]
  dubroom-clip validate <dir>
  dubroom-clip build <dir> [--out <dir>]   локальная сборка пакета (как media-worker)
  dubroom-clip publish <dir> --api <url> --key <STUDIO_KEY> [--wait] [--approve]
                                           --wait: дождаться обработки; --approve: сразу опубликовать
                                           (только для доверенного стартового набора)

Переменные окружения: DUBROOM_API, STUDIO_KEY.
`;

async function readManifest(dir: string): Promise<ClipManifest> {
  return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ClipManifest;
}

async function writeManifest(dir: string, m: ClipManifest) {
  await writeFile(join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
}

function printIssues(errors: Issue[], warnings: Issue[]) {
  for (const e of errors) console.error(`  ✗ ${e.path || "(root)"}: ${e.message}`);
  for (const w of warnings) console.warn(`  ⚠ ${w.path || "(root)"}: ${w.message}`);
}

function slugify(s: string): string {
  const tr: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  return (
    [...s.toLowerCase()]
      .map((c) => tr[c] ?? c)
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "clip"
  );
}

function sourcePaths(dir: string, m: ClipManifest) {
  const pick = (rel: string | undefined, fallback: string) => {
    const p = join(dir, rel ?? fallback);
    return existsSync(p) ? p : undefined;
  };
  return {
    video: pick(m.source?.video, "source/original.mp4"),
    bed: pick(m.source?.bed, "source/bed.wav"),
    dialogue: pick(m.source?.dialogue, "source/dialogue.wav"),
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, dirArg, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  if (!dirArg) {
    console.error("укажите каталог пакета\n\n" + HELP);
    return 2;
  }
  const dir = resolve(dirArg);
  const { values } = parseArgs({
    args: rest,
    options: {
      video: { type: "string" },
      bed: { type: "string" },
      dialogue: { type: "string" },
      title: { type: "string" },
      slug: { type: "string" },
      "from-srt": { type: "string" },
      "role-map": { type: "string" },
      lang: { type: "string", default: "ru" },
      out: { type: "string" },
      api: { type: "string", default: process.env.DUBROOM_API },
      key: { type: "string", default: process.env.STUDIO_KEY },
      wait: { type: "boolean", default: false },
      approve: { type: "boolean", default: false },
    },
  });

  switch (cmd) {
    case "init": {
      if (!values.video) {
        console.error("--video обязателен");
        return 2;
      }
      await mkdir(join(dir, "source"), { recursive: true });
      const copy = async (from: string | undefined, name: string) => {
        if (!from) return undefined;
        const rel = `source/${name}${extname(from)}`;
        await copyFile(from, join(dir, rel));
        return rel;
      };
      const video = await copy(values.video, "original");
      const bed = await copy(values.bed, "bed");
      const dialogue = await copy(values.dialogue, "dialogue");
      const p = await probe(join(dir, video!));
      const title = values.title ?? basename(dir);
      const m = emptyManifest({
        slug: values.slug ?? slugify(title),
        title: { ru: title },
        durationMs: p.durationMs,
        source: { video, bed, dialogue },
      });
      await writeManifest(dir, m);
      console.log(
        `✓ ${join(dir, "manifest.json")} (${(p.durationMs / 1000).toFixed(1)} с, ${p.video?.height ?? "?"}p)`,
      );
      console.log(
        "  дальше: заполните credit/license/roles, затем `dubroom-clip lines … --from-srt …`",
      );
      return 0;
    }

    case "synth": {
      const m = await readManifest(dir);
      const recipePath = join(dir, "synth.json");
      const recipe = existsSync(recipePath)
        ? (JSON.parse(await readFile(recipePath, "utf8")) as SynthRecipe)
        : {};
      const { video, bed } = await synthesizeSource(m, dir, recipe);
      m.source = { ...m.source, video: "source/original.mp4", bed: "source/bed.wav" };
      await writeManifest(dir, m);
      console.log(`✓ ${video}\n✓ ${bed}`);
      return 0;
    }

    case "separate": {
      const m = await readManifest(dir);
      const { video } = sourcePaths(dir, m);
      if (!video) {
        console.error("нет source/original.*");
        return 1;
      }
      const wav = join(dir, "source", "master.wav");
      await run("ffmpeg", ["-y", "-i", video, "-vn", "-ac", "2", "-ar", "44100", wav]);
      try {
        await run(
          "demucs",
          ["--two-stems=vocals", "-n", "htdemucs", "-o", join(dir, "source", "separated"), wav],
          {
            timeoutMs: 60 * 60_000,
          },
        );
      } catch (e) {
        console.error("demucs не найден или завершился с ошибкой. Установите: pip install demucs");
        console.error(String(e));
        return 1;
      }
      const sep = join(dir, "source", "separated", "htdemucs", "master");
      await copyFile(join(sep, "no_vocals.wav"), join(dir, "source", "bed.wav"));
      await copyFile(join(sep, "vocals.wav"), join(dir, "source", "dialogue.wav"));
      m.source = { ...m.source, bed: "source/bed.wav", dialogue: "source/dialogue.wav" };
      await writeManifest(dir, m);
      console.log("✓ source/bed.wav (фон) и source/dialogue.wav (голос)");
      return 0;
    }

    case "lines": {
      if (!values["from-srt"]) {
        console.error("--from-srt обязателен");
        return 2;
      }
      const m = await readManifest(dir);
      const cues = parseSrt(await readFile(values["from-srt"], "utf8"));
      const roleMap = values["role-map"]
        ? (JSON.parse(await readFile(values["role-map"], "utf8")) as Record<string, string>)
        : undefined;
      const lang = values.lang === "en" ? "en" : "ru";
      m.lines = linesFromSrt(cues, { lang, roleMap });
      // create missing roles referenced by lines
      for (const roleId of new Set(m.lines.map((l) => l.role))) {
        if (!m.roles.some((r) => r.id === roleId)) {
          m.roles.push({
            id: roleId,
            name: { [lang]: `Роль ${roleId.slice(1)}` },
            color: ROLE_COLORS[m.roles.length % ROLE_COLORS.length]!,
          });
        }
      }
      await writeManifest(dir, m);
      console.log(`✓ ${m.lines.length} реплик, ролей: ${m.roles.length}`);
      return 0;
    }

    case "validate": {
      const r = validateManifest(await readManifest(dir));
      printIssues(r.errors, r.warnings);
      console.log(r.ok ? "✓ манифест валиден" : `✗ ошибок: ${r.errors.length}`);
      return r.ok ? 0 : 1;
    }

    case "build": {
      const m = await readManifest(dir);
      const src = sourcePaths(dir, m);
      if (!src.video) {
        console.error("нет исходного видео (source/original.mp4)");
        return 1;
      }
      const outDir = resolve(values.out ?? join(dir, "dist"));
      try {
        const r = await buildPackage({
          manifest: m,
          video: src.video,
          bed: src.bed,
          dialogue: src.dialogue,
          outDir,
          log: (s) => console.log(`  · ${s}`),
        });
        printIssues([], r.warnings);
        console.log(`✓ пакет собран: ${outDir}`);
        return 0;
      } catch (e) {
        if (e instanceof BuildError) {
          console.error(`✗ ${e.message}`);
          printIssues(e.issues, []);
          return 1;
        }
        throw e;
      }
    }

    case "publish": {
      if (!values.api || !values.key) {
        console.error("нужны --api и --key (или DUBROOM_API / STUDIO_KEY)");
        return 2;
      }
      const m = await readManifest(dir);
      const r = validateManifest(m);
      printIssues(r.errors, r.warnings);
      if (!r.ok) return 1;
      const src = sourcePaths(dir, m);
      if (!src.video) {
        console.error("нет исходного видео");
        return 1;
      }
      const { draftId } = await publishPackage({
        api: values.api,
        key: values.key,
        manifest: m,
        files: src,
        log: (s) => console.log(`  · ${s}`),
      });
      console.log(`✓ отправлено на обработку, черновик ${draftId}. Статус — в Clip Studio.`);
      if (!values.wait && !values.approve) return 0;
      const base = values.api.replace(/\/$/, "");
      const headers = { authorization: `Bearer ${values.key}` };
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch(`${base}/api/studio/drafts/${draftId}`, { headers });
        const { draft } = (await res.json()) as {
          draft: {
            status: string;
            clipId: string;
            version: number;
            errors: Issue[];
            warnings: Issue[];
          };
        };
        if (draft.status === "failed") {
          console.error("✗ обработка не удалась");
          printIssues(draft.errors, []);
          return 1;
        }
        if (draft.status === "done") {
          printIssues([], draft.warnings);
          console.log(`✓ обработан: ${draft.clipId} v${draft.version} (статус review)`);
          if (values.approve) {
            const pub = await fetch(
              `${base}/api/studio/clips/${draft.clipId}/versions/${draft.version}/publish`,
              {
                method: "POST",
                headers,
              },
            );
            if (!pub.ok) {
              console.error(`✗ публикация: ${pub.status}`);
              return 1;
            }
            console.log("✓ опубликован");
          }
          return 0;
        }
      }
    }

    default:
      console.error(`неизвестная команда: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

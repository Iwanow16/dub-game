import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.ts";
import type { ClipManifest } from "./manifest.ts";

/**
 * Generates a synthetic demo source for a manifest: a cartoon-ish scene where each role is a
 * coloured character whose "mouth" opens exactly during its lines, plus a music bed. Lets the
 * starter pack live in git as text (manifest + recipe) and still be fully playable, and gives
 * the E2E/sync tests deterministic media.
 */
export interface SynthRecipe {
  /** lavfi background: gradients | mandelbrot | life | cellauto | testsrc2 | color */
  background?: "gradients" | "mandelbrot" | "life" | "cellauto" | "testsrc2" | "color";
  /** base note of the music bed, Hz */
  baseHz?: number;
  /** beats per minute of the bed pulse */
  bpm?: number;
}

function esc(text: string): string {
  // escaping for a drawtext value inside a filtergraph
  return text.replace(/\\/g, "\\\\").replace(/'/g, "’").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

export async function synthesizeSource(
  m: ClipManifest,
  dir: string,
  recipe: SynthRecipe = {},
): Promise<{ video: string; bed: string }> {
  await mkdir(join(dir, "source"), { recursive: true });
  const d = (m.durationMs / 1000).toFixed(3);
  const W = 1280;
  const H = 720;
  const bgs: Record<NonNullable<SynthRecipe["background"]>, string> = {
    gradients: `gradients=s=${W}x${H}:c0=0x1C1C28:c1=0x3a2a5a:c2=0x12121A:speed=0.02:r=30`,
    mandelbrot: `mandelbrot=s=${W}x${H}:r=30,hue=s=0.4,eq=brightness=-0.25`,
    life: `life=s=${W / 8}x${H / 8}:mold=10:r=30:ratio=0.1:death_color=#1C1C28:life_color=#3a3a5a,scale=${W}:${H}:flags=neighbor`,
    cellauto: `cellauto=s=${W / 8}x${H / 8}:rule=110:r=30,scale=${W}:${H}:flags=neighbor,eq=brightness=-0.3`,
    testsrc2: `testsrc2=s=${W}x${H}:r=30,eq=brightness=-0.35:saturation=0.5`,
    color: `color=c=0x26263A:s=${W}x${H}:r=30`,
  };
  const bg = bgs[recipe.background ?? "gradients"];

  const n = m.roles.length;
  const filters: string[] = [];
  m.roles.forEach((role, i) => {
    const cx = Math.round(((i + 1) * W) / (n + 1));
    const bodyW = 220;
    const x = cx - bodyW / 2;
    const color = role.color.replace("#", "0x");
    // body + eyes
    filters.push(`drawbox=x=${x}:y=260:w=${bodyW}:h=300:color=${color}@1:t=fill`);
    filters.push(`drawbox=x=${x + 45}:y=320:w=40:h=40:color=white@1:t=fill`);
    filters.push(`drawbox=x=${x + 135}:y=320:w=40:h=40:color=white@1:t=fill`);
    filters.push(`drawbox=x=${x + 57}:y=332:w=16:h=16:color=black@1:t=fill`);
    filters.push(`drawbox=x=${x + 147}:y=332:w=16:h=16:color=black@1:t=fill`);
    // closed mouth
    filters.push(`drawbox=x=${x + 70}:y=440:w=80:h=8:color=black@1:t=fill`);
    // open mouth while speaking — "flaps" at ~6 Hz so it reads as talking
    const lines = m.lines.filter((l) => l.role === role.id);
    if (lines.length) {
      const speaking = lines
        .map((l) => `between(t,${(l.startMs / 1000).toFixed(3)},${(l.endMs / 1000).toFixed(3)})`)
        .join("+");
      filters.push(
        `drawbox=x=${x + 70}:y=420:w=80:h=50:color=0x2a0a10@1:t=fill:enable='(${speaking})*gt(sin(t*38),-0.3)'`,
      );
    }
    const name = role.name.ru ?? role.name.en ?? role.id;
    filters.push(
      `drawtext=text='${esc(name)}':fontcolor=white:fontsize=34:x=${cx}-text_w/2:y=590:box=1:boxcolor=black@0.4:boxborderw=8`,
    );
  });
  const title = m.title.ru ?? m.title.en ?? m.slug;
  filters.push(
    `drawtext=text='${esc(title)}':fontcolor=white@0.85:fontsize=40:x=(w-text_w)/2:y=60`,
  );
  filters.push("format=yuv420p");

  const video = join(dir, "source", "original.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    bg,
    "-t",
    d,
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-an",
    video,
  ]);

  // music bed: a soft chord progression with a pulse, 48 kHz stereo
  const f = recipe.baseHz ?? 220;
  const bps = (recipe.bpm ?? 96) / 60;
  const chord = (k: number) =>
    `(sin(2*PI*${f * k}*t)+0.6*sin(2*PI*${(f * k * 5) / 4}*t)+0.5*sin(2*PI*${(f * k * 3) / 2}*t))`;
  // switch chord every 2 s: I – vi – IV – V
  const prog = `if(lt(mod(t,8),2),${chord(1)},if(lt(mod(t,8),4),${chord(5 / 6)},if(lt(mod(t,8),6),${chord(2 / 3)},${chord(3 / 4)})))`;
  const pulse = `(0.55+0.45*pow(1-mod(t*${bps},1),3))`;
  const expr = `0.06*${prog}*${pulse}`.replace(/,/g, "\\,");
  const bed = join(dir, "source", "bed.wav");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${expr}|${expr}:s=48000:d=${d}`,
    "-af",
    "afade=t=in:d=0.5,afade=t=out:st=" + Math.max(0, m.durationMs / 1000 - 1).toFixed(2) + ":d=1",
    bed,
  ]);
  return { video, bed };
}

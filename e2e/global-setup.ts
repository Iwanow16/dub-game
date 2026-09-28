import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** A 30 s tone stands in for a player's voice. */
export default function globalSetup() {
  if (!existsSync("e2e/fake-voice.wav")) {
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=f=180:d=30,volume=0.6",
      "-ac",
      "1",
      "-ar",
      "48000",
      "e2e/fake-voice.wav",
    ]);
  }
}

import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// E2E (§16): several browser contexts in one room with a fake microphone.
// Expects the dev stack running with the starter pack: ./scripts/dev.sh --seed
const executablePath = existsSync("/opt/pw-browsers/chromium")
  ? "/opt/pw-browsers/chromium"
  : undefined;

export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    locale: "ru-RU",
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=e2e/fake-voice.wav",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});

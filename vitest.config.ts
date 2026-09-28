import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["e2e/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 15000,
  },
});

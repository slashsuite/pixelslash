import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The smoke of a deployment (`moon run web:smoke`, SMOKE_BASE_URL and the smoke token in the env). Kept
// out of vitest.config.ts: it talks to a deployed server, so `moon run web:test` never runs it.
export default defineConfig({
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["smoke/**/*.smoke.ts"],
    globalSetup: ["../../scripts/test-tmp-scope.ts"],
    testTimeout: 30_000,
  },
});

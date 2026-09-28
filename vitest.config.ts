import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // vi.stubEnv / vi.stubGlobal are rolled back after every test; mocks after
    // each file, so no test can leak state into the next.
    unstubEnvs: true,
    unstubGlobals: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Phase 2.0 definition-of-done thresholds (per area). src/index.ts is the
      // process bootstrap (Discord login + worker loop) and is exercised by the
      // opt-in integration dry-run instead.
      exclude: ["src/index.ts"],
      thresholds: {
        "src/state/**": { lines: 80 },
        "src/trello/**": { lines: 80 },
        "src/github/**": { lines: 80 },
        "src/discord/**": { lines: 80 },
        // the secret boundary: assert-on-absence code, held to the highest bar
        "src/agent/**": { lines: 85 },
        "src/worker/**": { lines: 70 },
      },
    },
  },
});

import { defineConfig } from "vitest/config";

/**
 * Vitest config for E2E tests (GOAL-DG15).
 *
 * Run with: npx vitest run --config vitest.e2e.config.ts
 *
 * These tests use realistic GitHub API fixtures (not vi.mock() on the risk
 * engine) and validate the full evaluateGate() pipeline.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 15000,
  },
});

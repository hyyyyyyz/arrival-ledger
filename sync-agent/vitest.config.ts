import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/test_*.ts"],
    // Browser-backed fail-closed tests launch a real Playwright process. A cold
    // Chromium start can cross Vitest's 5 s default on macOS/Windows even when
    // the assertion itself completes normally.
    testTimeout: 10_000,
  },
});

import { defineConfig } from "@playwright/test";

/** Electron tests drive a real window: one worker, and a build must exist before they run. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  use: { trace: "retain-on-failure" },
});

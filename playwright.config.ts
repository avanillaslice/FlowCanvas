import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4318",
    viewport: { width: 1512, height: 960 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node dist/server/server/index.js",
    url: "http://127.0.0.1:4318/api/health",
    reuseExistingServer: false,
    env: {
      FLOWCANVAS_PORT: "4318",
      FLOWCANVAS_DATA_DIR: resolve(".local/e2e-data"),
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The renderer is a plain SPA loaded from disk by Electron, so every asset path must be relative.
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@core": resolve(__dirname, "src/core") } },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome126",
    // Two pages: the app, and the splash that has to paint before the app's bundle is even parsed.
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/renderer/index.html"),
        splash: resolve(__dirname, "src/renderer/splash.html"),
      },
    },
  },
  server: { port: 5273, strictPort: true },
});

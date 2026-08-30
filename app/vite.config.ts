import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The renderer is a plain SPA loaded from disk by Electron, so every asset path must be relative.
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@core": resolve(__dirname, "src/core") } },
  build: { outDir: resolve(__dirname, "dist/renderer"), emptyOutDir: true, target: "chrome126" },
  server: { port: 5273, strictPort: true },
});

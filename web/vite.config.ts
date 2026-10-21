import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  server: {
    host: '0.0.0.0',
    allowedHosts: true as any,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
    },
  },
  // A build egyetlen önálló HTML-fájl, amelyet a webOS IPK csomagoló
  // beletesz az LG TV alkalmazásba (index.html).
  build: {
    target: "es2015",
    outDir: path.resolve(__dirname, "../build/web"),
    emptyOutDir: true,
    // A webOS alkalmazás helyi fájlból tölti be az index.html-t; a single-file
    // build és a klasszikus IIFE kimenet csökkenti a modul/CORS problémákat.
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

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
  // A build egyetlen önálló HTML-fájl, amit az Android burok közvetlenül
  // beletesz az APK eszközei közé (assets/index.html).
  build: {
    target: "es2015",
    outDir: path.resolve(__dirname, "../build/web"),
    emptyOutDir: true,
    // Az APK-ban a lap file:///android_asset/index.html címről nyílik meg, ahol
    // a WebView a type="module" szkriptet nem feltétlenül futtatja (a modul
    // betöltés CORS-os útnak számít a file:// séma alatt). Ezért klasszikus,
    // IIFE formátumú, egyetlen szkript készül – ez minden WebView-ban lefut.
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

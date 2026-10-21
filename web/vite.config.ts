import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
 * INDULÓ VIDEÓ a fejlesztői szerveren.
 *
 * A TV-s csomagban a videó a build/webos/assets/intro.mp4 fájl (a repó
 * gyökerében lévő feltöltött videóból, lásd tools/build-webos.sh). A web
 * build viszont egyetlen HTML, ezért a böngészős előnézetben ez az útvonal
 * nem létezne – itt szolgáljuk ki a gyökérben lévő fájlt, hogy az előnézet
 * pontosan ugyanazt a videót mutassa, mint a TV.
 */
function introVideoDevServer(): Plugin {
  return {
    name: "iptv-intro-video-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/assets/intro.mp4", (_req, res, next) => {
        const candidates = [
          path.resolve(__dirname, "..", "intro.mp4"),
          path.resolve(__dirname, "..", "Autos_TV_logo_nagy_TV_gyors_1920x1080.mp4"),
        ];
        const file = candidates.find((candidate) => existsSync(candidate));
        if (!file) return next();
        const stat = statSync(file);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", stat.size);
        createReadStream(file).pipe(res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true }), introVideoDevServer()],
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

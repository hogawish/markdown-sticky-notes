// 画面側(src)をまとめて dist に出す。Tauriは dist を埋め込む(cargo build の前に npm run build が要る)。
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const p = (f) => fileURLToPath(new URL(f, import.meta.url));

export default defineConfig({
  root: "src",
  base: "./",
  clearScreen: false,
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: p("./src/index.html"), note: p("./src/note.html"), shortcuts: p("./src/shortcuts.html") },
    },
  },
});

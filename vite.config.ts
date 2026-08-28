import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // Off by default, on for a build you intend to profile: `EPISKO_SOURCEMAP=1 pnpm tauri
  // build`. The inspector now ships in release builds (the `devtools` Cargo feature), but
  // the bundle it opens on is 842KB of minified JavaScript, so every frame in a CPU
  // profile comes back as `Iu` or `Vf` — readable enough to tell library from app code
  // and useless for anything past that. This is the switch that makes a profile name our
  // own functions. It stays off by default because a normal release has no reason to ship
  // the source of every module beside it.
  // @ts-expect-error process is a nodejs global
  build: { sourcemap: !!process.env.EPISKO_SOURCEMAP },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

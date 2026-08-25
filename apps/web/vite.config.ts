import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.RELAY_API_PROXY_TARGET || "http://127.0.0.1:8000";
  const proxy = {
    target,
    changeOrigin: false,
    secure: false,
  };

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": proxy,
        "/health": proxy,
        "/mcp": proxy,
        "^/s/": proxy,
        "/version": proxy,
        "/.well-known": proxy,
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": proxy,
        "/health": proxy,
        "/mcp": proxy,
        "^/s/": proxy,
        "/version": proxy,
        "/.well-known": proxy,
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
    },
  };
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            // Preview libs stay in their own lazy chunks (loaded only when
            // previewing that file type) instead of bloating the vendor
            // bundle pulled on every launch.
            if (
              id.includes("@aiden0z") ||
              id.includes("docx-preview") ||
              id.includes("/xlsx/") ||
              id.includes("echarts") ||
              id.includes("jszip")
            ) {
              return undefined;
            }
            if (id.includes("react") || id.includes("react-dom")) return "react";
            if (id.includes("@monaco-editor")) return "monaco";
            if (id.includes("@xterm")) return "xterm";
            if (id.includes("lucide-react")) return "icons";
            return "vendor";
          }
        },
      },
    },
  },
});


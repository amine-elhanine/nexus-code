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
            // Preview libraries stay with their dynamic import path and load
            // only when a file of that type is opened.
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
          }
        },
      },
    },
  },
});


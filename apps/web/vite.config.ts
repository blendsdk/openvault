import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:8443",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});

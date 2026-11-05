import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const developmentOrigin = process.env.OPENVAULT_BASE_URL ?? "https://localhost";
const developmentTarget = process.env.OPENVAULT_DEV_URL ?? "https://localhost:8443";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: developmentTarget,
        secure: false,
        changeOrigin: true,
        configure(proxy) {
          // The server's origin guard compares the browser Origin against the
          // configured public origin, not the Vite dev origin.
          proxy.on("proxyReq", (request) => {
            request.setHeader("origin", developmentOrigin);
            request.setHeader("referer", `${developmentOrigin}/`);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules\/(react|react-dom|react-router|scheduler)\// },
            {
              name: "fluent",
              test: /node_modules\/(@fluentui|@griffel|@fluentui-react-icons)\//,
            },
            { name: "blendsdk", test: /node_modules\/(blendsdk|@blendsdk)\// },
          ],
        },
      },
    },
  },
});

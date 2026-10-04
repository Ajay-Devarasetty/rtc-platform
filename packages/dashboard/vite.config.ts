import { defineConfig } from "vite";

export default defineConfig({
  base: '/admin/',
  server: {
    port: 5181,
    proxy: {
      "/v1": "http://localhost:4000",
    },
  },
});

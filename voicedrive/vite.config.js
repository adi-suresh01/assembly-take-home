import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/token": "http://localhost:8787", "/command": "http://localhost:8787", "/clip": "http://localhost:8787" } },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base 用相对路径，GitHub Pages 项目子路径下可直接工作
export default defineConfig({
  base: "./",
  plugins: [react()],
});

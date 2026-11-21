import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { barArtifact } from "./build/bar-artifact.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [barArtifact()],
  build: {
    emptyOutDir: false,
    target: "es2023",
    minify: true,
    lib: { entry: resolve(root, "src/index.ts"), formats: ["es"], fileName: "worker" },
  },
  fmt: { ignorePatterns: ["AGENTS.md"] },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["dist/**"],
  },
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
});

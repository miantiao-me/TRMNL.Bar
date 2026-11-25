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
    minify: false,
    rolldownOptions: {
      external: ["@noble/ciphers/aes.js", "@noble/ciphers/utils.js", "valibot"],
      output: {
        paths: {
          "@noble/ciphers/aes.js": "https://esm.sh/@noble/ciphers@2.4.0/aes.js?target=es2022",
          "@noble/ciphers/utils.js": "https://esm.sh/@noble/ciphers@2.4.0/utils.js?target=es2022",
          valibot: "https://esm.sh/valibot@1.5.0?bundle&target=es2022",
        },
      },
    },
    lib: { entry: resolve(root, "src/index.ts"), formats: ["es"], fileName: "worker" },
  },
  fmt: { ignorePatterns: ["AGENTS.md"] },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["dist/**"],
  },
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
});

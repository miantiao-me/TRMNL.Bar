import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";
import { dashboardIcon } from "../src/config.ts";

const manifest = fileURLToPath(new URL("./TRMNL.bar.xml", import.meta.url));
const licenseFiles = [
  "../LICENSE",
  "../node_modules/valibot/LICENSE.md",
  "../node_modules/@noble/ciphers/LICENSE",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export function barArtifact(): Plugin {
  return {
    name: "trmnl-bar-artifact",
    buildStart() {
      this.addWatchFile(manifest);
      for (const file of licenseFiles) this.addWatchFile(file);
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      const entry = chunks[0];
      if (chunks.length !== 1 || !entry?.isEntry || entry.imports.length !== 0) {
        this.error("Build the dashboard as one self-contained Worker.");
      }
      const licenses = licenseFiles.map((file) => readFileSync(file, "utf8").trim()).join("\n\n");
      const code = `/*\n${licenses}\n*/\n${entry.code}`.replaceAll("]]>", "]]]]><![CDATA[>");
      const source = readFileSync(manifest, "utf8")
        .replace("__TRMNL_ICON__", dashboardIcon)
        .replace("__TRMNL_WORKER__", () => code);
      if (Buffer.byteLength(source) > 8 * 1024 * 1024) {
        this.error("The dashboard exceeds the Metrix.Bar 8 MiB installation limit.");
      }
      delete bundle[entry.fileName];
      this.emitFile({ type: "asset", fileName: "TRMNL.bar", source });
    },
  };
}

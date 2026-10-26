import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import process from "node:process";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";

// Bundled dependencies whose licenses ask for their notice in every copy.
const notices = [
	["yaml", "node_modules/yaml/LICENSE"],
	["@noble/hashes", "node_modules/@noble/hashes/LICENSE"],
]
	.map(([name, file]) => `${name}\n\n${readFileSync(file, "utf8").trim()}`)
	.join("\n\n----\n\n")
	.replace(/\*\//g, "* /");
const banner = `/*!\nAttachment Lens. MIT License. See LICENSE in the source repository.\n\nThis file includes the following third-party software:\n\n${notices}\n*/`;

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian provides these at runtime. The plugin itself imports only "obsidian".
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2021",
  platform: "browser",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  legalComments: "inline",
  banner: { js: banner },
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

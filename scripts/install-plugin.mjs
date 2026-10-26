// Copies the built plugin into a vault you choose: node scripts/install-plugin.mjs path/to/vault
// Run `npm run build` first. Doesn't enable the plugin; turn it on in Settings → Community plugins.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
if (!process.argv[2]) {
	console.error("Usage: npm run install-plugin -- path/to/vault");
	process.exit(1);
}
const vault = resolve(process.argv[2]);
const { id } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const config = process.env.OBSIDIAN_CONFIG_DIR ?? ".obsidian";

if (!existsSync(join(vault, config))) {
	console.error(`No ${config} folder in ${vault}. Open the folder as a vault in Obsidian once, then rerun.`);
	process.exit(1);
}
if (!existsSync(join(root, "main.js"))) {
	console.error("main.js is missing. Run `npm run build` first.");
	process.exit(1);
}

const target = join(vault, config, "plugins", id);
mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(root, file), join(target, file));
console.log(`Installed ${id} into ${target}`);

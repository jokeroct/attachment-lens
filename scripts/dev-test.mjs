// Runs the in-Obsidian checks in the dedicated test vault:
//   node scripts/dev-test.mjs [check ...] [--keep-open]
// Resets .dev-vault/ from test-vault/ (keeping its .obsidian folder), installs the built plugin and
// dev/harness, enables both, opens the vault in Obsidian (a separate window; other vaults stay as
// they are), waits for the harness and prints the results. Run `npm run build` first.
// The first time, Obsidian asks whether to trust the vault's plugins; answer that in Obsidian.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const vault = join(root, ".dev-vault");
const args = process.argv.slice(2);
const keepOpen = args.includes("--keep-open");
const requested = args.filter((a) => !a.startsWith("--"));
const checks = requested.length > 0 ? requested : ["cache", "scan", "processThrow", "repairs", "openEditor", "unsavedEditor", "canvasOpen", "stale", "undoConflict", "recovery", "incremental", "keyboard", "screens", "large"];

if (!existsSync(join(root, "main.js"))) {
	console.error("main.js is missing. Run `npm run build` first.");
	process.exit(1);
}

// Reset the vault content from the fixtures. Only this generated copy is touched.
mkdirSync(join(vault, ".obsidian"), { recursive: true });
for (const entry of readdirSync(vault)) if (entry !== ".obsidian") rmSync(join(vault, entry), { recursive: true, force: true });
for (const entry of readdirSync(join(root, "test-vault"))) {
	if (entry === ".obsidian") continue;
	cpSync(join(root, "test-vault", entry), join(vault, entry), { recursive: true });
}
const config = join(vault, ".obsidian");
if (!existsSync(join(config, "app.json"))) copyFileSync(join(root, "test-vault", ".obsidian", "app.json"), join(config, "app.json"));
const install = (id, from, files) => {
	const target = join(config, "plugins", id);
	mkdirSync(target, { recursive: true });
	for (const file of files) copyFileSync(join(from, file), join(target, file));
	rmSync(join(target, "data.json"), { force: true });
};
const { id: pluginId } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const harnessDir = join(root, "dev", "harness");
const { id: harnessId } = JSON.parse(readFileSync(join(harnessDir, "manifest.json"), "utf8"));
install(pluginId, root, ["main.js", "manifest.json", "styles.css"]);
install(harnessId, harnessDir, ["main.js", "manifest.json"]);
const enabledPath = join(config, "community-plugins.json");
const enabled = existsSync(enabledPath) ? JSON.parse(readFileSync(enabledPath, "utf8")) : [];
for (const id of [pluginId, harnessId]) if (!enabled.includes(id)) enabled.push(id);
writeFileSync(enabledPath, `${JSON.stringify(enabled, null, 2)}\n`);

const open = (uri) => {
	if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", uri]);
	else execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [uri]);
};
const appData = process.env.APPDATA ?? join(process.env.HOME ?? "", ".config");
const vaultList = join(appData, "obsidian", "obsidian.json");
const norm = (p) => resolve(p).toLowerCase();
const findId = () => {
	const { vaults } = JSON.parse(readFileSync(vaultList, "utf8"));
	return Object.entries(vaults).find(([, v]) => norm(v.path) === norm(vault))?.[0] ?? null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let vaultId = findId();
if (!vaultId) {
	console.log(`Opening ${vault} in Obsidian for the first time. If Obsidian asks whether to trust this vault's plugins, choose to trust them there.`);
	open(`obsidian://open?path=${encodeURIComponent(vault)}`);
	const until = Date.now() + 300_000;
	while (!(vaultId = findId())) {
		if (Date.now() > until) {
			console.error("The vault wasn't added to Obsidian's vault list. Open it in Obsidian once, then rerun.");
			process.exit(1);
		}
		await sleep(1000);
	}
}

const done = join(vault, ".al-checks-done");
rmSync(done, { force: true });
writeFileSync(join(vault, ".al-run-checks"), [...checks, ...(keepOpen ? [] : ["close"])].join("\n"));
open(`obsidian://open?vault=${vaultId}`);
console.log(`Running ${checks.join(", ")} in ${vault}…`);

const deadline = Date.now() + 900_000;
while (!existsSync(done)) {
	if (Date.now() > deadline) {
		console.error("Timed out waiting for the harness. Is the vault open, with its plugins trusted?");
		process.exit(1);
	}
	await sleep(1000);
}

const { results, ranAt } = JSON.parse(readFileSync(join(vault, ".al-test-results.json"), "utf8"));
let failed = 0;
for (const name of checks) {
	const result = results[name];
	const pass = result?.pass === true;
	if (!pass) failed++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${result?.ms ? `  (${result.ms} ms)` : ""}`);
	for (const [check, ok] of Object.entries(result?.checks ?? {})) if (!ok) console.log(`        ✗ ${check}`);
	if (result?.error) console.log(`        error: ${result.error.split("\n").slice(0, 3).join(" | ")}`);
	for (const error of result?.errors ?? []) console.log(`        console: ${error.split("\n")[0]}`);
}
console.log(`Ran at ${ranAt}. Details: ${join(vault, ".al-test-results.json")}`);
process.exit(failed > 0 ? 1 : 0);

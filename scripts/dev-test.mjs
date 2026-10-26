// Runs the in-Obsidian checks in a test vault:
//   node scripts/dev-test.mjs --vault <path> [check ...] [--keep-open]
//   node scripts/dev-test.mjs --vault <path> --cleanup
//   node scripts/dev-test.mjs --vault <path> --fixtures docs/demo-vault docs   (README screenshots)
// The vault (default: $AL_DEV_VAULT, else .dev-vault/) must already be in Obsidian's vault list with
// community plugins allowed. It may be shared with other projects: the fixtures from test-vault/ are
// copied in as top-level folders, and the run refuses to start if any of those names already exist
// without having been created by an earlier run. Afterwards the copied fixtures, the harness's
// scratch folders and its trigger files are removed again, and the vault's workspace layout is put
// back. Results and screenshots are copied to .dev-results/ first. Run `npm run build` before this.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const vaultIndex = args.indexOf("--vault");
const vault = resolve(vaultIndex !== -1 ? (args[vaultIndex + 1] ?? "") : (process.env.AL_DEV_VAULT ?? join(root, ".dev-vault")));
const fixturesIndex = args.indexOf("--fixtures");
const fixturesDir = resolve(root, fixturesIndex !== -1 ? (args[fixturesIndex + 1] ?? "") : "test-vault");
const keepOpen = flag("--keep-open");
const requested = args.filter((a, i) => !a.startsWith("--") && i !== vaultIndex + 1 && i !== fixturesIndex + 1);
const checks = requested.length > 0 ? requested : ["cache", "scan", "processThrow", "repairs", "openEditor", "unsavedEditor", "canvasOpen", "stale", "undoConflict", "recovery", "incremental", "keyboard", "screens", "large"];
const config = join(vault, ".obsidian");
const manifestPath = join(vault, ".al-fixtures.json");
const results = join(root, ".dev-results");
const SCRATCH = ["Harness", "Large"];
const FILES = [".al-run-checks", ".al-checks-done", ".al-test-results.json"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(config)) {
	console.error(`${vault} has no .obsidian folder. Open it as a vault in Obsidian once, then rerun.`);
	process.exit(1);
}

/** Removes everything a run added: the fixture folders, scratch folders and trigger files. */
function cleanup() {
	const created = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
	for (const entry of created) rmSync(join(vault, entry), { recursive: true, force: true });
	for (const file of FILES) rmSync(join(vault, file), { force: true });
	rmSync(join(vault, ".al-shots"), { recursive: true, force: true });
	const backup = join(results, "workspace.json");
	if (existsSync(backup)) copyFileSync(backup, join(config, "workspace.json"));
	rmSync(manifestPath, { force: true });
	console.log(`Removed ${created.length} added entries from ${vault} and restored its workspace layout.`);
}

if (flag("--cleanup")) {
	cleanup();
	process.exit(0);
}

if (!existsSync(join(root, "main.js"))) {
	console.error("main.js is missing. Run `npm run build` first.");
	process.exit(1);
}

// Undo an earlier run's copies, then make sure nothing we'd add already exists.
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
for (const entry of previous) rmSync(join(vault, entry), { recursive: true, force: true });
const existing = new Set(readdirSync(vault));
const fixtures = readdirSync(fixturesDir).filter((e) => e !== ".obsidian");
const clashes = [...fixtures, ...SCRATCH].filter((e) => existing.has(e));
if (clashes.length > 0) {
	console.error(`${vault} already has ${clashes.join(", ")}, which this run would overwrite. Nothing was changed.`);
	process.exit(1);
}
writeFileSync(manifestPath, `${JSON.stringify([...fixtures, ...SCRATCH], null, 2)}\n`);
for (const entry of fixtures) cpSync(join(fixturesDir, entry), join(vault, entry), { recursive: true });
mkdirSync(results, { recursive: true });
if (existsSync(join(config, "workspace.json")) && previous.length === 0) copyFileSync(join(config, "workspace.json"), join(results, "workspace.json"));

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

const appData = process.env.APPDATA ?? join(process.env.HOME ?? "", ".config");
const { vaults } = JSON.parse(readFileSync(join(appData, "obsidian", "obsidian.json"), "utf8"));
const norm = (p) => resolve(p).toLowerCase();
const vaultId = Object.entries(vaults).find(([, v]) => norm(v.path) === norm(vault))?.[0];
if (!vaultId) {
	console.error(`${vault} isn't in Obsidian's vault list. Open it in Obsidian once (Open folder as vault), then rerun.`);
	cleanup();
	process.exit(1);
}

const done = join(vault, ".al-checks-done");
rmSync(done, { force: true });
writeFileSync(join(vault, ".al-run-checks"), [...checks, ...(keepOpen ? [] : ["close"])].join("\n"));
const uri = `obsidian://open?vault=${vaultId}`;
if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", uri]);
else execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [uri]);
console.log(`Running ${checks.join(", ")} in ${vault}…`);

const deadline = Date.now() + 1_200_000;
while (!existsSync(done)) {
	if (Date.now() > deadline) {
		console.error("Timed out waiting for the harness. Is the vault open, with community plugins allowed?");
		process.exit(1);
	}
	await sleep(1000);
}

const output = JSON.parse(readFileSync(join(vault, ".al-test-results.json"), "utf8"));
writeFileSync(join(results, "results.json"), JSON.stringify(output, null, 2));
rmSync(join(results, "shots"), { recursive: true, force: true });
if (existsSync(join(vault, ".al-shots"))) cpSync(join(vault, ".al-shots"), join(results, "shots"), { recursive: true });

let failed = 0;
for (const name of checks) {
	const result = output.results[name];
	const pass = result?.pass === true;
	if (!pass) failed++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${result?.ms ? `  (${result.ms} ms)` : ""}`);
	for (const [check, ok] of Object.entries(result?.checks ?? {})) if (!ok) console.log(`        ✗ ${check}`);
	if (result?.error) console.log(`        error: ${result.error.split("\n").slice(0, 3).join(" | ")}`);
	for (const error of result?.errors ?? []) console.log(`        console: ${error.split("\n")[0]}`);
}
console.log(`Ran at ${output.ranAt}. Details: ${join(results, "results.json")}`);

if (keepOpen) {
	console.log(`The vault stays open with the fixtures in place. Afterwards run: node scripts/dev-test.mjs --vault "${vault}" --cleanup`);
} else {
	await sleep(4000); // let the window close and Obsidian save its layout before restoring it
	cleanup();
}
process.exit(failed > 0 ? 1 : 0);

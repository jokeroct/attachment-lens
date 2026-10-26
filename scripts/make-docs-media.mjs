// Turns the docs check's captures into the README's images and GIF:
//   node scripts/dev-test.mjs --vault <path> --fixtures docs/demo-vault docs
//   node scripts/make-docs-media.mjs
// Needs ffmpeg on the PATH.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const shots = join(root, ".dev-results", "shots");
const out = join(root, "docs", "images");
if (!existsSync(join(shots, "gif", "frames.json"))) {
	console.error("No captures found. Run the docs check first (see the comment at the top of this script).");
	process.exit(1);
}
mkdirSync(out, { recursive: true });

const names = {
	"docs-overview-light.png": "overview-light.png",
	"docs-overview-dark.png": "overview-dark.png",
	"docs-first-scan-light.png": "first-scan.png",
	"docs-suggestions-light.png": "suggestions.png",
	"docs-review-light.png": "review.png",
	"docs-repaired-dark.png": "repaired.png",
	"docs-uncertain-dark.png": "uncertain.png",
	"docs-coverage-dark.png": "coverage.png",
	"docs-narrow-light.png": "narrow.png",
	"docs-settings-light.png": "settings.png",
};
for (const [from, to] of Object.entries(names)) copyFileSync(join(shots, from), join(out, to));

// Each frame is held for its recorded time; the last one is listed twice so its duration applies.
const frames = JSON.parse(readFileSync(join(shots, "gif", "frames.json"), "utf8"));
const list = frames.map((f) => `file '${f.file}'\nduration ${(f.hold / 1000).toFixed(2)}`).join("\n");
writeFileSync(join(shots, "gif", "list.txt"), `${list}\nfile '${frames[frames.length - 1].file}'\n`);
const gif = join(out, "repair-flow.gif");
execFileSync("ffmpeg", [
	"-hide_banner", "-loglevel", "error", "-y",
	"-f", "concat", "-safe", "0", "-i", join(shots, "gif", "list.txt"),
	"-vf", "fps=10,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a",
	"-loop", "0", gif,
]);
for (const file of [...Object.values(names), "repair-flow.gif"]) console.log(`${file.padEnd(22)} ${(statSync(join(out, file)).size / 1024).toFixed(0)} KB`);

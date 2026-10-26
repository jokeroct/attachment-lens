// Packages the built plugin for manual installation:
//   dist/attachment-lens-<version>/{main.js, manifest.json, styles.css}
//   dist/attachment-lens-<version>.zip (the same three files in an attachment-lens/ folder)
// Run `npm run build` first.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const files = ["main.js", "manifest.json", "styles.css"];
for (const file of files) {
	if (!existsSync(join(root, file))) {
		console.error(`${file} is missing. Run \`npm run build\` first.`);
		process.exit(1);
	}
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.version !== manifest.version) {
	console.error(`package.json is ${pkg.version} but manifest.json is ${manifest.version}.`);
	process.exit(1);
}

const name = `${manifest.id}-${manifest.version}`;
const out = join(root, "dist", name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const entries = files.map((file) => ({ name: `${manifest.id}/${file}`, data: readFileSync(join(root, file)) }));
for (const file of files) writeFileSync(join(out, file), readFileSync(join(root, file)));

// A store-only ZIP, so packaging needs no dependencies.
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
const locals = [];
const centrals = [];
let offset = 0;
for (const entry of entries) {
	const nameBuf = Buffer.from(entry.name, "utf8");
	const crc = crc32(entry.data);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0x0800, 6);
	local.writeUInt16LE(0, 8);
	local.writeUInt16LE(dosTime, 10);
	local.writeUInt16LE(dosDate, 12);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(entry.data.length, 18);
	local.writeUInt32LE(entry.data.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);
	locals.push(local, nameBuf, entry.data);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x0800, 8);
	central.writeUInt16LE(0, 10);
	central.writeUInt16LE(dosTime, 12);
	central.writeUInt16LE(dosDate, 14);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(entry.data.length, 20);
	central.writeUInt32LE(entry.data.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);
	central.writeUInt32LE(offset, 42);
	centrals.push(central, nameBuf);
	offset += local.length + nameBuf.length + entry.data.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, ...centrals, end]);
writeFileSync(join(root, "dist", `${name}.zip`), zip);

const sums = files.map((file) => `${createHash("sha256").update(readFileSync(join(out, file))).digest("hex")}  ${file}`);
writeFileSync(join(out, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.log(`Packaged ${name}:`);
for (const line of sums) console.log(`  ${line}`);
console.log(`  dist/${name}.zip (${zip.length.toLocaleString()} bytes)`);

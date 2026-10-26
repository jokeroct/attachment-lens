// Writes the binary attachments and the Windows-line-ending note in test-vault/.
// Run with `npm run fixtures`. Images are small PNG gradients, also for .jpg/.jpeg/.webp names:
// Obsidian's renderer sniffs the content, so they preview correctly.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const vault = resolve(import.meta.dirname, "..", "test-vault");

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
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
};

/** A 96×72 PNG fading from `top` to `bottom`, with a darker band across the lower third. */
function png(top, bottom) {
	const w = 96;
	const h = 72;
	const rows = [];
	for (let y = 0; y < h; y++) {
		const t = y / (h - 1);
		const band = y > h * 0.62 ? 0.55 : 1;
		const row = Buffer.alloc(1 + w * 3);
		for (let x = 0; x < w; x++) {
			for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round((top[c] * (1 - t) + bottom[c] * t) * band);
		}
		rows.push(row);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** A PDF with one solid-colour page per entry of `colors` ("r g b", 0–1). */
function pdf(colors) {
	const objects = [null, "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${colors.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${colors.length} >>`];
	colors.forEach((color, i) => {
		const content = `${color} rg 0 0 612 792 re f`;
		objects[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << >> >>`;
		objects[4 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
	});
	let out = "%PDF-1.4\n";
	const offsets = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = out.length;
		out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

/** An empty ZIP archive; .docx and .xlsx files are ZIP containers too. */
const emptyZip = () => Buffer.concat([Buffer.from("PK\x05\x06", "latin1"), Buffer.alloc(18)]);
/** Placeholder bytes for media files. They aren't playable; only their presence matters. */
const placeholder = (label) => Buffer.from(`Attachment Lens fixture: ${label}. Not a playable file.\n`);

const files = {
	"Assets/2024/kyoto-temple.jpg": png([246, 210, 168], [106, 44, 34]),
	"Assets/2024/kyoto-temple-2.jpg": png([207, 217, 230], [110, 48, 38]),
	"Assets/2024/cover.png": png([180, 200, 240], [40, 60, 120]),
	"Assets/2023/cover.png": png([240, 220, 160], [120, 80, 20]),
	"Assets/my photo 1.png": png([200, 240, 210], [30, 90, 60]),
	"Assets/Ünïcödé 写真.png": png([250, 200, 220], [120, 30, 80]),
	"Assets/café.png": png([230, 210, 190], [90, 60, 40]),
	"Assets/Covers/banner-dune.jpeg": png([240, 200, 140], [140, 90, 40]),
	"Travel/attachments/kyoto temple.webp": png([185, 211, 196], [46, 64, 56]),
	"Travel/attachments/bamboo-grove.png": png([170, 220, 150], [30, 70, 30]),
	"Research/Figures/fig-1.png": png([255, 255, 255], [120, 120, 140]),
	"Research/Figures/fig-3.png": png([240, 240, 255], [60, 60, 120]),
	"Research/Papers/attention-is-all-you-need.pdf": pdf(["0.95 0.95 0.95", "0.85 0.9 1", "1 0.9 0.8"]),
	"Inbox/scan-0042.pdf": pdf(["1 1 0.9"]),
	"Orphans/unused-scan.pdf": pdf(["0.9 1 0.9"]),
	"Audio/Interviews/interview-2024-03-01.m4a": placeholder("interview audio"),
	"Audio/lecture-4.mp3": placeholder("lecture audio"),
	"Video/demo-walkthrough.mp4": placeholder("demo video"),
	"Archives/site-backup-2023.zip": emptyZip(),
	"Finance/budget-2025.xlsx": emptyZip(),
	"Finance/report.docx": emptyZip(),
	"Misc/notes.txt": Buffer.from("Plain text attachment used by the Attachment Lens fixtures.\n"),
	"Misc/data.xyz": Buffer.from("A file type nothing knows about.\n"),
	"Misc/diagram.svg": Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72" viewBox="0 0 96 72"><rect width="96" height="72" fill="#e8eef8"/><circle cx="30" cy="36" r="16" fill="#5b7bd5"/><rect x="54" y="20" width="28" height="32" fill="#d58a5b"/></svg>\n',
	),
	"Links/Windows line endings.md": Buffer.from("# Windows line endings\r\n\r\nBroken: ![[kyoto-temple-old.jpg]]\r\nThe line after stays as it is.\r\n"),
};

for (const [path, data] of Object.entries(files)) {
	const target = join(vault, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, data);
}
console.log(`Wrote ${Object.keys(files).length} fixture files to ${vault}`);

// Writes docs/demo-vault/: a small, realistic vault for the README's screenshots and GIF.
// Needs ffmpeg on the PATH for the images, audio and video. Run: node scripts/make-demo-vault.mjs
// Five references are broken on purpose, one of them an uncertain plain-text property.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "docs", "demo-vault");
rmSync(root, { recursive: true, force: true });

const write = (path, data) => {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, data);
};
const ffmpeg = (args, path) => {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, target]);
};

/** A flat illustration: a vertical gradient with filled boxes [x, y, w, h, color] drawn over it. */
function scene(path, top, bottom, boxes, size = "960x640") {
	const [w, h] = size.split("x").map(Number);
	const draw = boxes.map(([x, y, bw, bh, c]) => `drawbox=x=${x}:y=${y}:w=${bw}:h=${bh}:color=0x${c}@1:t=fill`).join(",");
	const gradient = `gradients=s=${size}:c0=0x${top}:c1=0x${bottom}:x0=${w / 2}:y0=0:x1=${w / 2}:y1=${h}:nb_colors=2:speed=0.0001,format=rgb24`;
	const quality = path.endsWith(".jpg") || path.endsWith(".jpeg") ? ["-q:v", "3"] : [];
	ffmpeg(["-f", "lavfi", "-i", gradient, "-frames:v", "1", ...(draw ? ["-vf", draw] : []), ...quality], path);
}

const temple = (ground) => [
	[0, 430, 960, 210, ground],
	[360, 250, 240, 180, "8c2f22"],
	[330, 230, 300, 26, "4a1c15"],
	[310, 330, 340, 18, "4a1c15"],
	[440, 330, 80, 100, ground],
];
scene("Attachments/kyoto-temple.jpg", "f7c59f", "7a3b2e", temple("2e1f1b"));
scene("Attachments/kyoto-temple-2.jpg", "b9cfe6", "5d6f8c", temple("1f2633"));
scene("Attachments/bamboo-grove.jpg", "d9efc9", "3f6b3a", [...[60, 190, 330, 470, 610, 760, 880].map((x, i) => [x, 0, 34 + (i % 3) * 8, 640, i % 2 ? "2f5a2b" : "4f8a43"]), [0, 560, 960, 80, "243d22"]]);
scene("Attachments/fushimi-inari.jpg", "fde6c8", "f0a35c", [...[0, 1, 2, 3].flatMap((i) => [[150 + i * 170, 140, 30, 500, "c8351f"], [270 + i * 170, 140, 30, 500, "c8351f"], [120 + i * 170, 120, 240, 26, "1e1a18"], [140 + i * 170, 175, 200, 16, "c8351f"]]), [0, 600, 960, 40, "3a2a22"]]);
scene("Attachments/tea-ceremony.png", "efe4d2", "c9b28f", [[0, 470, 960, 170, "8a6b4a"], [380, 300, 200, 170, "3f5d45"], [360, 290, 240, 20, "2c4232"], [600, 380, 140, 90, "d8cbb2"]]);
scene("Attachments/dotonbori night.png", "1b2340", "0b0f1f", [[0, 520, 960, 120, "05070f"], [90, 120, 120, 300, "e8425d"], [260, 90, 160, 120, "f2c14e"], [260, 240, 160, 200, "2bc4b6"], [470, 140, 140, 280, "9b5de5"], [660, 100, 200, 160, "f15bb5"], [660, 300, 200, 140, "00bbf9"]]);
scene("Attachments/Design/moodboard.jpg", "f4efe9", "e6dccf", [[60, 60, 400, 260, "e9c46a"], [500, 60, 400, 120, "2a9d8f"], [500, 200, 190, 120, "264653"], [710, 200, 190, 120, "f4a261"], [60, 350, 260, 230, "e76f51"], [340, 350, 560, 230, "8ab17d"]]);
scene("Attachments/Design/homepage-mockup.png", "fafafa", "eef0f4", [[0, 0, 960, 70, "1f2a44"], [60, 110, 520, 50, "1f2a44"], [60, 180, 420, 22, "9aa3b5"], [60, 214, 380, 22, "9aa3b5"], [60, 270, 180, 52, "5b6cf9"], [620, 100, 280, 260, "c9d1ff"], [60, 400, 260, 180, "e3e7f0"], [350, 400, 260, 180, "e3e7f0"], [640, 400, 260, 180, "e3e7f0"]]);
scene("Attachments/Design/colour-palette.png", "ffffff", "ffffff", ["264653", "2a9d8f", "e9c46a", "f4a261", "e76f51"].map((c, i) => [i * 192, 0, 192, 640, c]));
scene("Attachments/Design/old-logo.png", "ffffff", "f1f1f1", [[330, 170, 300, 300, "5b6cf9"], [390, 230, 180, 180, "ffffff"], [440, 280, 80, 80, "5b6cf9"]]);
scene("Attachments/Figures/transformer-architecture.png", "ffffff", "ffffff", [[300, 60, 360, 70, "f8d7a4"], [300, 160, 360, 70, "c7e2f5"], [300, 260, 360, 70, "d6f0c7"], [300, 360, 360, 70, "c7e2f5"], [300, 460, 360, 70, "f2c4c4"], [470, 130, 20, 30, "666666"], [470, 230, 20, 30, "666666"], [470, 330, 20, 30, "666666"], [470, 430, 20, 30, "666666"]]);
scene("Attachments/Figures/results-table-v3.png", "ffffff", "ffffff", [[80, 80, 800, 60, "e8ecf5"], ...[0, 1, 2, 3, 4, 5].map((r) => [80, 160 + r * 70, 800, 2, "c6ccd8"]), [360, 80, 2, 480, "c6ccd8"], [620, 80, 2, 480, "c6ccd8"]]);
scene("Attachments/Covers/dune-cover.jpeg", "f6c177", "b4652d", [[0, 420, 960, 220, "8a4a22"], [0, 360, 520, 120, "a85a2a"], [420, 390, 540, 110, "9c5126"], [680, 110, 90, 90, "fff1d6"]], "640x960");
scene("Attachments/Inbox/scan-0042.jpg", "f7f7f2", "ecece4", [[90, 90, 780, 30, "c9c9c0"], [90, 150, 640, 18, "dadad2"], [90, 190, 700, 18, "dadad2"], [90, 230, 520, 18, "dadad2"]]);

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
write("Attachments/Documents/attention-is-all-you-need.pdf", pdf(["0.97 0.97 0.97", "0.93 0.95 1", "1 0.95 0.9"]));
write("Attachments/Documents/rail-pass.pdf", pdf(["0.9 0.95 1"]));
write("Attachments/Documents/receipts-march.pdf", pdf(["1 1 0.95", "0.98 0.98 0.92"]));
write("Attachments/Inbox/scan-0043.pdf", pdf(["1 1 1"]));
ffmpeg(["-f", "lavfi", "-i", "sine=frequency=528:duration=2", "-c:a", "aac", "-b:a", "48k"], "Attachments/Audio/temple-bells.m4a");
ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32"], "Attachments/Video/street-walk.mp4");
write("Attachments/Archive/site-backup-2023.zip", Buffer.concat([Buffer.from("PK\x05\x06", "latin1"), Buffer.alloc(18)]));

write(
	"Home.md",
	`# Home

Notes from trips, reading and work.

- [[Kyoto trip 2024]] and [[Osaka day trip]]
- [[Literature review]]
- [[Dune]] and the [[Reading list.base|reading list]]
- The [[Website redesign.canvas|website redesign board]] and the [[Japan itinerary.canvas|Japan itinerary]]

![[kyoto-temple.jpg|320]]
`,
);
write(
	"Travel/Kyoto trip 2024.md",
	`---
cover: "[[kyoto-temple.jpg]]"
tags:
  - travel
  - japan
---
# Kyoto trip 2024

Three days in March, mostly on foot.

## Day 1: Arashiyama

![[bamboo-grove.jpg]]
Early start to beat the crowds at the bamboo grove.

## Day 2: Fushimi Inari

![[fushimi-inari.jpg|500]]

## Day 3: Higashiyama

![[kyoto-temple.jpeg|400]]
Kiyomizu-dera at 7am, before the tour buses.

![[tea-ceremony.png]]

## Paperwork

- Rail pass: [[rail-pass.pdf]]
- Receipts: [[receipts-march.pdf#page=2|March receipts]]
- Temple bells, recorded on the last morning: ![[temple-bells.m4a]]
`,
);
write(
	"Travel/Osaka day trip.md",
	`# Osaka day trip

Dinner along the canal, then a walk through Namba.

![[dotonbori-night.png]]

![Street walk](../Attachments/Video/street-walk.mp4)
`,
);
write(
	"Research/Literature review.md",
	`# Literature review

The starting point is [[attention-is-all-you-need.pdf#page=3|Vaswani et al., p. 3]], which introduces the Transformer.

![The architecture][fig1]

Our replication results are in the table below.

![[results-table-v2.png]]

[fig1]: ../Attachments/Figures/transformer-architecture.png "Figure 1"
`,
);
write(
	"Reading/Dune.md",
	`---
banner: dune-cover.jpg
author: Frank Herbert
year: 1965
---
# Dune

Rereading for the book club. The banner property is read by a theme.
`,
);
write(
	"Reading list.base",
	`formulas:
  cover: image("Attachments/Covers/dune-cover.jpeg")
views:
  - type: cards
    name: Books
`,
);
write(
	"Projects/Website redesign.canvas",
	`${JSON.stringify(
		{
			nodes: [
				{ id: "g1", type: "group", label: "Direction", background: "Attachments/Design/moodboard.jpg", backgroundStyle: "cover", x: -40, y: -40, width: 940, height: 640 },
				{ id: "c1", type: "file", file: "Attachments/Design/homepage-mockup.png", x: 0, y: 0, width: 480, height: 320 },
				{ id: "t1", type: "text", text: "## Palette\nUse the agreed palette: ![[color-palette.png|240]]", x: 520, y: 0, width: 340, height: 220 },
			],
			edges: [{ id: "e1", fromNode: "c1", fromSide: "right", toNode: "t1", toSide: "left" }],
		},
		null,
		"\t",
	)}\n`,
);
write(
	"Travel/Japan itinerary.canvas",
	`${JSON.stringify(
		{
			nodes: [
				{ id: "k1", type: "file", file: "Attachments/kyoto-temple.jpg", x: 0, y: 0, width: 400, height: 280 },
				{ id: "k2", type: "file", file: "Attachments/fushimi-inari.jpg", x: 440, y: 0, width: 400, height: 280 },
				{ id: "k3", type: "text", text: "## Day 3\nKiyomizu-dera at sunrise, then tea in Gion. ![[tea-ceremony.png|200]]", x: 0, y: 320, width: 840, height: 200 },
				{ id: "k4", type: "file", file: "Travel/Kyoto trip 2024.md", x: 880, y: 0, width: 360, height: 520 },
			],
			edges: [{ id: "e1", fromNode: "k1", fromSide: "bottom", toNode: "k3", toSide: "top" }],
		},
		null,
		"\t",
	)}\n`,
);
console.log(`Wrote the demo vault to ${root}`);

import { describeExpression } from "../core/bases/bases";
import type { Reference } from "../core/types";

/** Where a reference sits, in words: "line 14", "property cover, item 2", "file card “Day 3”". */
export function placeLabel(ref: Pick<Reference, "place" | "form">): string {
	const place = ref.place;
	switch (place.type) {
		case "body":
			return `line ${place.line}`;
		case "property":
			return place.index === null ? `property ${place.key}` : `property ${place.key}, item ${place.index + 1}`;
		case "canvas":
			if (place.field === "background") return `background of group “${place.label}”`;
			if (place.field === "file") return `file card ${place.nodeId}`;
			return `text card “${place.label}”`;
		case "base":
			return `${describeExpression(place.expression)}, line ${place.line}`;
	}
}

/** What kind of reference it is: "Embed, wikilink", "Link, Markdown", "Reference definition". */
export function formLabel(ref: Pick<Reference, "form" | "embed" | "place" | "confidence">): string {
	if (ref.form === "refdef") return "Reference definition";
	if (ref.place.type === "property") return ref.confidence === "uncertain" ? "Plain-text property" : "Property link";
	if (ref.place.type === "canvas" && ref.form === "path") return ref.place.field === "background" ? "Group background" : "File card";
	if (ref.place.type === "base") return ref.place.fn ? `Bases ${ref.place.fn}()` : "Text in a Bases expression";
	const kind = ref.embed ? "Embed" : "Link";
	return `${kind}, ${ref.form === "wikilink" ? "wikilink" : "Markdown"}`;
}

import { srLabel } from "./dom";

// A keyboard-operable list that only creates elements for the rows in view, so a vault with tens
// of thousands of attachments stays fast. Follows the listbox pattern with aria-activedescendant.

export interface VirtualListOptions<T> {
	rowHeight: number;
	id: (item: T) => string;
	/** Screen-reader name of the list */
	name: string;
	render: (item: T, row: HTMLElement) => void;
	onSelect: (item: T) => void;
	onActivate: (item: T) => void;
}

const OVERSCAN = 6;

export class VirtualList<T> {
	readonly el: HTMLElement;
	private readonly spacer: HTMLElement;
	private items: T[] = [];
	private selected = -1;
	private rendered = new Map<number, HTMLElement>();
	private frame: number | null = null;
	private readonly prefix = `al-row-${Math.random().toString(36).slice(2, 8)}`;

	constructor(
		parent: HTMLElement,
		private readonly options: VirtualListOptions<T>,
	) {
		this.el = parent.createDiv({ cls: "al-list-scroll", attr: { role: "listbox", tabindex: "0" } });
		srLabel(this.el, options.name);
		this.spacer = this.el.createDiv({ cls: "al-list-spacer" });
		this.el.addEventListener("scroll", () => this.schedule());
		this.el.addEventListener("keydown", (evt) => this.onKey(evt));
		this.el.addEventListener("click", (evt) => {
			const row = (evt.target as HTMLElement).closest<HTMLElement>(".al-row");
			if (!row) return;
			const index = Number(row.dataset.index);
			this.select(index, false);
			this.el.focus({ preventScroll: true });
		});
		this.el.addEventListener("dblclick", (evt) => {
			const row = (evt.target as HTMLElement).closest<HTMLElement>(".al-row");
			const item = row ? this.items[Number(row.dataset.index)] : undefined;
			if (item !== undefined) this.options.onActivate(item);
		});
	}

	setItems(items: T[], selectedId: string | null): void {
		this.items = items;
		this.selected = selectedId === null ? -1 : items.findIndex((item) => this.options.id(item) === selectedId);
		this.el.setAttribute("aria-setsize", String(items.length));
		this.spacer.setCssProps({ "--al-list-height": `${items.length * this.options.rowHeight}px` });
		for (const row of this.rendered.values()) row.remove();
		this.rendered.clear();
		this.draw();
		this.updateActive();
	}

	get selectedItem(): T | undefined {
		return this.items[this.selected];
	}

	get length(): number {
		return this.items.length;
	}

	focus(): void {
		this.el.focus();
	}

	/** Selects by index and scrolls it into view. `fromKey` scrolls; clicks don't need to. */
	select(index: number, fromKey: boolean): void {
		if (this.items.length === 0) return;
		const clamped = Math.max(0, Math.min(this.items.length - 1, index));
		const changed = clamped !== this.selected;
		this.selected = clamped;
		if (fromKey) this.scrollIntoView(clamped);
		this.draw();
		this.updateActive();
		const item = this.items[clamped];
		if (changed && item !== undefined) this.options.onSelect(item);
	}

	/** Scrolls just enough to show the row, or puts it in the middle when `center` is set. */
	scrollIntoView(index: number, center = false): void {
		const top = index * this.options.rowHeight;
		const bottom = top + this.options.rowHeight;
		const visible = top >= this.el.scrollTop && bottom <= this.el.scrollTop + this.el.clientHeight;
		if (center && !visible) this.el.scrollTop = Math.max(0, top - (this.el.clientHeight - this.options.rowHeight) / 2);
		else if (top < this.el.scrollTop) this.el.scrollTop = top;
		else if (bottom > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = bottom - this.el.clientHeight;
	}

	private pageSize(): number {
		return Math.max(1, Math.floor(this.el.clientHeight / this.options.rowHeight) - 1);
	}

	private onKey(evt: KeyboardEvent): void {
		const keys: Record<string, () => number> = {
			ArrowDown: () => this.selected + 1,
			ArrowUp: () => (this.selected === -1 ? 0 : this.selected - 1),
			Home: () => 0,
			End: () => this.items.length - 1,
			PageDown: () => this.selected + this.pageSize(),
			PageUp: () => this.selected - this.pageSize(),
		};
		const next = keys[evt.key];
		if (next) {
			evt.preventDefault();
			this.select(next(), true);
			return;
		}
		if (evt.key === "Enter" || evt.key === " ") {
			const item = this.items[this.selected];
			if (item !== undefined) {
				evt.preventDefault();
				this.options.onActivate(item);
			}
		}
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.draw();
		});
	}

	private draw(): void {
		const { rowHeight } = this.options;
		const height = this.el.clientHeight || rowHeight * 20;
		const first = Math.max(0, Math.floor(this.el.scrollTop / rowHeight) - OVERSCAN);
		const last = Math.min(this.items.length - 1, Math.ceil((this.el.scrollTop + height) / rowHeight) + OVERSCAN);
		for (const [index, row] of this.rendered) {
			if (index < first || index > last) {
				row.remove();
				this.rendered.delete(index);
			}
		}
		for (let index = first; index <= last; index++) {
			const item = this.items[index];
			if (item === undefined) continue;
			let row = this.rendered.get(index);
			if (!row) {
				row = this.spacer.createDiv({ cls: "al-row", attr: { role: "option", id: `${this.prefix}-${index}`, "aria-posinset": String(index + 1) } });
				row.dataset.index = String(index);
				row.setCssProps({ "--al-row-top": `${index * rowHeight}px` });
				this.options.render(item, row);
				this.rendered.set(index, row);
			}
			row.toggleClass("is-selected", index === this.selected);
			row.setAttribute("aria-selected", String(index === this.selected));
		}
	}

	private updateActive(): void {
		if (this.selected >= 0 && this.rendered.has(this.selected)) this.el.setAttribute("aria-activedescendant", `${this.prefix}-${this.selected}`);
		else this.el.removeAttribute("aria-activedescendant");
	}

	destroy(): void {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.el.remove();
	}
}

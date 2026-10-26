import { PluginSettingTab, setIcon, type App, type SettingDefinitionItem } from "obsidian";
import type AttachmentLensPlugin from "./main";

/** The author's Ko-fi page, also the manifest's fundingUrl. */
export const KOFI_URL = "https://ko-fi.com/mdsama";

export interface Settings {
	/** Folders to skip, one per line */
	excludedFolders: string;
	suggestionCount: number;
	scanOnOpen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	excludedFolders: "",
	suggestionCount: 5,
	scanOnOpen: false,
};

export function parseSettings(value: unknown): Settings {
	const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const count = typeof raw.suggestionCount === "number" && Number.isFinite(raw.suggestionCount) ? Math.round(raw.suggestionCount) : DEFAULT_SETTINGS.suggestionCount;
	return {
		excludedFolders: typeof raw.excludedFolders === "string" ? raw.excludedFolders : DEFAULT_SETTINGS.excludedFolders,
		suggestionCount: Math.min(10, Math.max(3, count)),
		scanOnOpen: typeof raw.scanOnOpen === "boolean" ? raw.scanOnOpen : DEFAULT_SETTINGS.scanOnOpen,
	};
}

/** Excluded folders as vault paths without leading or trailing slashes. */
export function excludedFolders(settings: Settings): string[] {
	return settings.excludedFolders
		.split("\n")
		.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
		.filter((line) => line !== "");
}

export class AttachmentLensSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: AttachmentLensPlugin,
	) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Excluded folders",
				desc: "One folder per line. Files in these folders aren't listed or read. The configuration folder and .trash are always skipped. Takes effect on the next scan.",
				control: { type: "textarea", key: "excludedFolders", placeholder: "Templates\nArchive/Old", rows: 4 },
			},
			{
				name: "Number of suggestions",
				desc: "How many possible replacements to show for a broken reference.",
				control: { type: "slider", key: "suggestionCount", min: 3, max: 10, step: 1 },
			},
			{
				name: "Scan when the panel opens",
				desc: "Results are kept in memory only. With this on, opening the panel after restarting Obsidian scans again automatically.",
				control: { type: "toggle", key: "scanOnOpen" },
			},
			{
				type: "group",
				heading: "Support",
				items: [
					{
						name: "Support Attachment Lens",
						desc: "Attachment Lens is free. If it helps you, you can support its development on Ko-fi.",
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText("Support me on Ko-fi").onClick(() => window.open(KOFI_URL));
								// A button holds an icon or text, not both, so the icon goes in beside the text.
								button.buttonEl.addClass("al-kofi-button");
								setIcon(button.buttonEl.createSpan({ cls: "al-kofi-icon", prepend: true }), "coffee");
							});
						},
					},
				],
			},
		];
	}

	override getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof Settings];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = parseSettings({ ...this.plugin.settings, [key]: value });
		await this.plugin.saveState();
	}
}

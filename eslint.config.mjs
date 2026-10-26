import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	{
		ignores: ["main.js", "dist/**", "node_modules/**", ".dev-vault/**", "test-vault/**", "dev/**", "scripts/**", "esbuild.config.mjs", "vitest.config.mts", "docs/**"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
			},
		},
		rules: {
			// The plugin's own name and Obsidian's feature names keep their capitals.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{ brands: ["Attachment Lens", "Obsidian", "Canvas", "Markdown", "Excalidraw", "Dataview", "Templater", "Lucide", "Windows"], acronyms: ["PDF", "JSON", "YAML", "HTML", "CSS", "URL", "SVG"] },
			],
		},
	},
	{
		// Tests run in Node with fixtures from disk; plugin-only rules don't apply there.
		files: ["tests/**/*.ts"],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/prefer-create-el": "off",
			"obsidianmd/ui/sentence-case": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"import/no-nodejs-modules": "off",
		},
	},
]);

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("shouldRunFirstTimeSetup", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.PI_EXPERIMENTAL = "1";
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true when experimental, default agent dir, and no settings.json", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when experimental features are disabled", () => {
		delete process.env.PI_EXPERIMENTAL;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("FirstTimeSetupComponent", () => {
	it("submits the theme without an analytics step", () => {
		initTheme("dark");
		const onSubmit = vi.fn();
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: vi.fn(),
			onSubmit,
			onCancel: vi.fn(),
		});

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledWith({ theme: "dark" });
	});
});

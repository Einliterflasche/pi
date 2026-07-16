import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession permission modes", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("restricts strict read-only mode and restores the previous active tools", async () => {
		harness = await createHarness();
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		harness.session.enablePermissions(undefined, "read-only");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls"]);
		expect(harness.session.systemPrompt).toContain("Use only the verified built-in read, grep, find, and ls tools");

		harness.session.setPermissionMode("auto-read-only");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(harness.session.systemPrompt).toContain(
			"Use only tool calls that are clearly and verifiably non-altering",
		);
	});
});

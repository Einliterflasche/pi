import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeForkEditorTextFile, createForkEditorTextFile } from "../src/core/fork-handoff.ts";

describe("fork editor handoff", () => {
	it("stores editor text in a private temporary file and consumes it once", () => {
		const filePath = createForkEditorTextFile("selected prompt\nwith multiple lines");

		expect(existsSync(filePath)).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(filePath).mode & 0o777).toBe(0o600);
		}
		expect(consumeForkEditorTextFile(filePath)).toBe("selected prompt\nwith multiple lines");
		expect(existsSync(filePath)).toBe(false);
	});

	it("rejects paths outside the fork handoff namespace", () => {
		expect(() => consumeForkEditorTextFile("/tmp/not-a-pi-fork-file.txt")).toThrow(
			"Invalid fork editor handoff path",
		);
	});
});

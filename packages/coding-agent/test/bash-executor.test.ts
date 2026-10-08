import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

describe("bash executor output persistence", () => {
	it.each(["completed", "cancelled", "abort error"])(
		"saves clean output when ANSI sequences span chunks (%s)",
		async (completion) => {
			const controller = new AbortController();
			const output = "x".repeat(DEFAULT_MAX_BYTES + 1);
			const result = await executeBashWithOperations(
				"fixture",
				process.cwd(),
				{
					exec: async (_command, _cwd, { onData }) => {
						for (const chunk of ["\u001b[3", `1m${output}\u001b[0`, "m"]) onData(Buffer.from(chunk));
						if (completion !== "completed") controller.abort();
						if (completion === "abort error") throw new Error("aborted");
						return { exitCode: 0 };
					},
				},
				{ signal: controller.signal },
			);

			expect(result.truncated).toBe(true);
			expect(result.cancelled).toBe(completion !== "completed");
			expect(result.exitCode).toBe(completion === "completed" ? 0 : undefined);
			expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(output);
		},
	);

	for (const [limit, output] of [
		["lines", Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `line ${i}\n`).join("")],
		["bytes", "x".repeat(DEFAULT_MAX_BYTES + 1)],
	]) {
		it.each(["completed", "cancelled", "abort error"])(
			`finishes saving output truncated by ${limit} before returning (%s)`,
			async (completion) => {
				const controller = new AbortController();
				const result = await executeBashWithOperations(
					"fixture",
					process.cwd(),
					{
						exec: async (_command, _cwd, { onData }) => {
							onData(Buffer.from(output));
							if (completion !== "completed") controller.abort();
							if (completion === "abort error") throw new Error("aborted");
							return { exitCode: 0 };
						},
					},
					{ signal: controller.signal },
				);

				expect(result.truncated).toBe(true);
				expect(result.cancelled).toBe(completion !== "completed");
				expect(result.exitCode).toBe(completion === "completed" ? 0 : undefined);
				expect(result.fullOutputPath).toBeDefined();
				expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(output);
			},
		);
	}
});

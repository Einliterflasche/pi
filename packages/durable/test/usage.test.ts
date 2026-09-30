import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addUsageState, type UsageState } from "../src/harness/usage.ts";

function usage(source: "reported" | "estimated" | null): Usage {
	return {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cacheWrite1h: 1,
		reasoning: 1,
		totalTokens: 19,
		cost: source === null ? null : { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, source },
	};
}

describe("durable usage totals", () => {
	it.each([
		[null, "reported", null],
		["reported", null, null],
		["reported", "estimated", "estimated"],
		["estimated", "reported", "estimated"],
		["reported", "reported", "reported"],
	] as const)("combines %s and %s billing as %s", (first, second, source) => {
		const sum: UsageState = { models: {}, tools: {} };
		const one: UsageState = { models: { model: usage(first) }, tools: { tool: usage(first) } };
		const two: UsageState = { models: { model: usage(second) }, tools: { tool: usage(second) } };
		addUsageState(sum, one);
		addUsageState(sum, two);
		for (const total of [sum.models.model, sum.tools.tool]) {
			expect(total).toMatchObject({
				input: 20,
				output: 4,
				cacheRead: 6,
				cacheWrite: 8,
				cacheWrite1h: 2,
				reasoning: 2,
				totalTokens: 38,
			});
			if (source === null) expect(total.cost).toBeNull();
			else expect(total.cost).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20, source });
		}
		expect(one.models.model).toEqual(usage(first));
		expect(two.tools.tool).toEqual(usage(second));
	});
});

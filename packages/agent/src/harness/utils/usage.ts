import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, source: "estimated" },
	};
}

export function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
		totalTokens: left.totalTokens + right.totalTokens,
		// Cost tracking only exists where both sides have it (OpenRouter); a null
		// cost on either side means untracked, and mixing real and estimated
		// numbers degrades the sum to an estimate.
		cost:
			left.cost && right.cost
				? {
						input: left.cost.input + right.cost.input,
						output: left.cost.output + right.cost.output,
						cacheRead: left.cost.cacheRead + right.cost.cacheRead,
						cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
						total: left.cost.total + right.cost.total,
						source:
							left.cost.source === "reported" && right.cost.source === "reported" ? "reported" : "estimated",
					}
				: null,
	};
}

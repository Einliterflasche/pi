import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function openRouterModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openrouter", "anthropic/claude-sonnet-4.5")!;
	return { ...baseModel, ...(compat ? { compat } : {}) } as Model<"openai-completions">;
}

function openAIModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { ...baseModel, api: "openai-completions" } as unknown as Model<"openai-completions">;
}

async function captureParams(
	model: Model<"openai-completions">,
	options?: { openRouterRouting?: Record<string, unknown> },
): Promise<{ provider?: unknown }> {
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{ apiKey: "test", onPayload: () => {}, ...options },
	).result();
	return (mockState.lastParams ?? {}) as { provider?: unknown };
}

describe("openai-completions openRouterRouting override", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("uses model compat routing when no override is given", async () => {
		const params = await captureParams(openRouterModel({ openRouterRouting: { sort: "price" } }));
		expect(params.provider).toEqual({ sort: "price" });
	});

	it("merges the request override over model compat routing", async () => {
		const params = await captureParams(openRouterModel({ openRouterRouting: { sort: "price", only: ["a"] } }), {
			openRouterRouting: { sort: "throughput" },
		});
		expect(params.provider).toEqual({ sort: "throughput", only: ["a"] });
	});

	it("ignores the override for non-OpenRouter targets", async () => {
		const params = await captureParams(openAIModel(), { openRouterRouting: { sort: "throughput" } });
		expect(params.provider).toBeUndefined();
	});
});

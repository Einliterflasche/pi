import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: Record<string, unknown>) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: { content: "hi" }, finish_reason: null }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								// OpenRouter usage accounting shape
								usage: {
									prompt_tokens: 100,
									completion_tokens: 50,
									prompt_tokens_details: { cached_tokens: 20 },
									cost: 0.0123,
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

describe("openrouter reported cost", () => {
	it("requests usage accounting and reports billed cost", async () => {
		const model = getModel("openrouter", "openai/gpt-4o-mini");
		let partial: { usage?: { cost?: { total?: number; source?: string } } } | undefined;
		for await (const ev of streamOpenAICompletions(
			model,
			{
				systemPrompt: "x",
				messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "sk-test" },
		)) {
			if (ev.type === "start") {
				// Final usage replaces `partial.usage` on this same object; read after consuming.
				partial = (ev as unknown as { partial: { usage?: { cost?: { total?: number; source?: string } } } })
					.partial;
			}
		}
		// Opt-in to OpenRouter usage accounting
		expect(mockState.lastParams?.usage).toEqual({ include: true });
		// Billed cost comes from the provider's usage accounting, not catalog rates
		expect(partial?.usage?.cost?.total).toBe(0.0123);
		expect(partial?.usage?.cost?.source).toBe("reported");
	});
});

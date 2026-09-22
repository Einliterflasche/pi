import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("input_received subscriptions", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("receives input once during settlement and defers its agent run", async () => {
		const received: string[] = [];
		let markSettling = () => {};
		const settling = new Promise<void>((resolve) => {
			markSettling = resolve;
		});
		let releaseSettlement = () => {};
		const settlementReleased = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		let settled = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_received", (event) => {
						received.push(event.text);
					});
					pi.on("agent_settled", async () => {
						if (settled) return;
						settled = true;
						markSettling();
						await settlementReleased;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);

		const firstPrompt = harness.session.prompt("first input");
		try {
			await settling;
			await harness.session.prompt("second input");
			expect(received).toEqual(["first input", "second input"]);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		} finally {
			releaseSettlement();
			await firstPrompt;
			await harness.session.waitForIdle();
		}
		expect(received).toEqual(["first input", "second input"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	// Keep the fork event consistent with upstream unsubscribe semantics (pi#8967).
	it("applies subscription changes across extensions on the next input", async () => {
		const calls: string[] = [];
		let secondExtension: ExtensionAPI;
		let unsubscribeSecond: () => void;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const unsubscribeFirst = pi.on("input_received", () => {
						calls.push("first");
						unsubscribeFirst();
						unsubscribeSecond();
						pi.on("input_received", () => {
							calls.push("added first");
						});
						secondExtension.on("input_received", () => {
							calls.push("added second");
						});
					});
					pi.on("input_received", () => {
						calls.push("sibling");
					});
				},
				(pi) => {
					secondExtension = pi;
					unsubscribeSecond = pi.on("input_received", () => {
						calls.push("second");
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);

		await harness.session.prompt("first input");
		expect(calls).toEqual(["first", "sibling", "second"]);
		calls.length = 0;
		await harness.session.prompt("second input");
		expect(calls).toEqual(["sibling", "added first", "added second"]);
	});
});

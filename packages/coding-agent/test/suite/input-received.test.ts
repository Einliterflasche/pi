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

import {
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
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

	it.each([false, true])("updates transcript permissions with a forced prompt: %s", async (forcePrompt) => {
		const requests: TranscriptContext[] = [];
		harness = await createHarness({
			extensionFactories: forcePrompt
				? [
						(pi) => {
							pi.on("before_agent_start", () => ({ systemPrompt: "Worker instructions." }));
						},
					]
				: undefined,
		});
		harness.setResponses(
			Array.from({ length: 4 }, () => (context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage("done");
			}),
		);
		harness.session.enablePermissions(undefined, "read-only");
		await harness.session.prompt("inspect once");
		await harness.session.prompt("inspect again");
		harness.session.setPermissionMode("auto-read-only");
		await harness.session.prompt("inspect with approval checks");
		harness.session.setPermissionMode("skip");
		await harness.session.prompt("continue normally");

		const prompts = requests.map((context) => getCurrentSystemPrompt(context.messages));
		const strictInstruction = "Use only the verified built-in read, grep, find, and ls tools";
		const autoInstruction = "Use only tool calls that are clearly and verifiably non-altering";
		expect(prompts[0].split(strictInstruction)).toHaveLength(2);
		expect(prompts[1]).toBe(prompts[0]);
		expect(prompts[2]).toContain(autoInstruction);
		expect(prompts[2]).not.toContain(strictInstruction);
		expect(prompts[3]).not.toContain(autoInstruction);
		expect(prompts[3]).not.toContain(strictInstruction);
		if (forcePrompt) expect(prompts[3]).toBe("Worker instructions.");
		expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
		expect(getCurrentTools(requests[2].messages).map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
	});

	it("prepares the system prompt and permissions for a fresh custom-message turn", async () => {
		harness = await createHarness();
		harness.session.enablePermissions(undefined, "read-only");
		let request: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("inspected");
			},
		]);

		await harness.session.sendCustomMessage(
			{ customType: "continuation", content: "Inspect the project", display: true },
			{ triggerTurn: true },
		);

		expect(request).toBeDefined();
		expect(getCurrentSystemPrompt(request!.messages)).toBe(harness.session.systemPrompt);
		expect(getCurrentSystemPrompt(request!.messages)).toContain(
			"Use only the verified built-in read, grep, find, and ls tools",
		);
		expect(getCurrentTools(request!.messages).map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
	});

	it("keeps strict read-only tools when extensions change the prompt loadout", async () => {
		let advertisedTools: string[] = [];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.selectedTools = ["read", "write"];
					});
				},
			],
		});
		harness.session.enablePermissions(undefined, "read-only");
		harness.session.setActiveToolsByName(["read", "write"]);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		harness.setResponses([
			(context) => {
				advertisedTools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage("inspected");
			},
		]);

		await harness.session.prompt("inspect");

		expect(advertisedTools).toEqual(["read"]);
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
	});

	it("keeps strict read-only tools when navigating to a broader transcript loadout", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		const firstLeaf = harness.sessionManager.getLeafId();
		if (!firstLeaf) throw new Error("expected first turn in transcript");
		harness.session.enablePermissions(undefined, "read-only");
		await harness.session.prompt("second");

		await harness.session.navigateTree(firstLeaf);

		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		let request: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("inspected");
			},
		]);
		await harness.session.prompt("inspect earlier state");
		expect(request).toBeDefined();
		expect(getCurrentTools(request!.messages).map((tool) => tool.name)).toEqual(["read"]);
		expect(getCurrentSystemPrompt(request!.messages)).toContain(
			"Use only the verified built-in read, grep, find, and ls tools",
		);
	});
});

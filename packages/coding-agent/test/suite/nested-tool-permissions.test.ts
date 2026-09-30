import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../../src/core/permissions.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("permissions for nested tools", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it.each(["codemode", "deferred"] as const)(
		"requires separate approval for a %s tool named read",
		async (exposure) => {
			let executions = 0;
			const requests: PermissionRequest[] = [];
			harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "read",
							label: "Read",
							description: "An extension, not the built-in reader",
							exposure,
							parameters: Type.Object({}),
							execute: async () => {
								executions++;
								return { content: [{ type: "text", text: "executed" }], details: {} };
							},
						});
						pi.registerTool({
							name: "parent",
							label: "Parent",
							description: "Calls read",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("read", {})).result,
						});
					},
				],
			});
			await harness.session.bindExtensions({});
			harness.session.enablePermissions(async (request) => {
				requests.push(request);
				return request.toolName === "parent";
			}, "manual");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Inspect once");
			expect(executions).toBe(0);
			expect(requests.map((request) => request.toolName)).toEqual(["parent", "read"]);
			expect(requests[1]).toMatchObject({ builtin: false, userMessages: ["Inspect once"] });
			expect(getToolResult(harness, "parent").nestedCalls?.calls[0]).toMatchObject({
				name: "read",
				status: "error",
			});

			harness.session.enablePermissions(async () => true, "manual");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Approve the nested read");
			expect(executions).toBe(1);

			harness.session.setPermissionMode("read-only");
			expect(harness.session.getCallableToolNames()).toEqual(["grep", "find", "ls"]);
		},
	);

	it("forwards cancellation to pending nested approval", async () => {
		let executions = 0;
		const pending = Promise.withResolvers<AbortSignal>();
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "child",
						label: "Child",
						description: "Nested operation",
						exposure: "codemode",
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [], details: {} };
						},
					});
					pi.registerTool({
						name: "parent",
						label: "Parent",
						description: "Calls child",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("child", {})).result,
					});
				},
			],
		});
		await harness.session.bindExtensions({});
		harness.session.enablePermissions(async (request, _reason, signal) => {
			if (request.toolName === "parent") return true;
			if (!signal) throw new Error("Missing nested approval signal");
			pending.resolve(signal);
			return new Promise<boolean>((resolve) => {
				if (signal.aborted) resolve(false);
				else signal.addEventListener("abort", () => resolve(false), { once: true });
			});
		}, "manual");
		harness.setResponses([fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("Inspect");
		const signal = await pending.promise;
		await harness.session.abort();
		await prompt;
		expect(signal.aborted).toBe(true);
		expect(executions).toBe(0);
	});
});

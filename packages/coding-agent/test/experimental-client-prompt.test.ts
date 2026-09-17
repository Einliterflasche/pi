import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClient } from "../src/experimental/client.ts";
import type { AgentOperationResponse, AgentPromptResult } from "../src/experimental/services/agent-controller.ts";

const runtimeMocks = vi.hoisted(() => ({ open: vi.fn(), activate: vi.fn() }));
vi.mock("../src/experimental/client-runtime.ts", () => ({
	openClientRuntime: runtimeMocks.open,
	activateBuiltinClientServices: runtimeMocks.activate,
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function createRuntime() {
	const reply = deferred<AgentOperationResponse>();
	const completion = deferred<AgentPromptResult>();
	const prompt = vi.fn(() => reply.promise);
	const waitForPrompt = vi.fn(() => completion.promise);
	const dispose = vi.fn(async () => {});
	const server = {
		route: { serverId: "server" },
		directory: { state: { value: { sessions: [{ sessionId: "session" }] } } },
		plugins: { prepareSession: async () => {} },
		management: { attach: async () => {} },
		agent: { prompt, waitForPrompt },
	};
	runtimeMocks.open.mockResolvedValue({ servers: [server], dispose });
	runtimeMocks.activate.mockResolvedValue(server);
	return { reply, completion, prompt, waitForPrompt, dispose };
}

describe("experimental client prompt completion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each(["before", "after"])("returns an answer that settles %s the prompt reply", async (order) => {
		const runtime = createRuntime();
		const result = runClient({ command: "client", sessionId: "session", prompt: "question" });
		await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledOnce());
		if (order === "before") runtime.completion.resolve({ status: "done", text: "complete answer", reason: null });
		expect(runtime.dispose).not.toHaveBeenCalled();
		expect(runtime.waitForPrompt).not.toHaveBeenCalled();
		runtime.reply.resolve({ accepted: true, operationId: "42", error: null });
		if (order === "after") {
			await vi.waitFor(() => expect(runtime.waitForPrompt).toHaveBeenCalledWith("42", expect.anything()));
			await setImmediate();
			expect(runtime.dispose).not.toHaveBeenCalled();
			runtime.completion.resolve({ status: "done", text: "complete answer", reason: null });
		}
		await expect(result).resolves.toEqual({
			kind: "prompted", serverId: "server", sessionId: "session", text: "complete answer",
		});
		expect(runtime.waitForPrompt).toHaveBeenCalledWith("42", expect.anything());
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it.each(["transport closed", "session detached"])("reports %s while completion is pending", async (message) => {
		const runtime = createRuntime();
		const result = runClient({ command: "client", sessionId: "session", prompt: "question" });
		const rejected = expect(result).rejects.toThrow(message);
		runtime.reply.resolve({ accepted: true, operationId: "42", error: null });
		await vi.waitFor(() => expect(runtime.waitForPrompt).toHaveBeenCalledOnce());
		runtime.completion.reject(new Error(message));
		await rejected;
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("reports an unanswered prompt", async () => {
		const runtime = createRuntime();
		runtime.reply.resolve({ accepted: true, operationId: "42", error: null });
		runtime.completion.resolve({ status: "unanswered", text: null, reason: "aborted" });
		await expect(runClient({ command: "client", sessionId: "session", prompt: "question" })).rejects.toThrow(
			"Prompt was not answered: aborted",
		);
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("returns a rejected prompt without waiting for completion", async () => {
		const runtime = createRuntime();
		runtime.reply.resolve({ accepted: false, operationId: null, error: { code: "busy", message: "busy" } });
		await expect(runClient({ command: "client", sessionId: "session", prompt: "question" })).rejects.toThrow("busy");
		expect(runtime.waitForPrompt).not.toHaveBeenCalled();
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});
});

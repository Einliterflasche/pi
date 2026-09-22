import { setImmediate } from "node:timers/promises";
import { replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type LaneWatchEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConnectionStateChange } from "@earendil-works/pi-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClient } from "../src/experimental/client.ts";
import type { AgentOperationResponse } from "../src/experimental/services/agent-controller.ts";
import type { TranscriptState } from "../src/experimental/services/transcript.ts";

const runtimeMocks = vi.hoisted(() => ({ open: vi.fn(), activate: vi.fn() }));
vi.mock("../src/experimental/client-runtime.ts", () => ({
	openClientRuntime: runtimeMocks.open,
	activateBuiltinClientServices: runtimeMocks.activate,
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function createRuntime() {
	const transcript = replicatedState<TranscriptState>({
		snapshot: {
			lane: "main",
			transcript: [],
			tipId: null,
			configuration: { model: { provider: "faux", modelId: "faux" }, thinkingLevel: "off", activeToolNames: [] },
			stats: {
				messageCount: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
			},
			operation: null,
			queues: [],
			faulted: false,
		},
		event: null,
	});
	const reply = deferred<AgentOperationResponse>();
	const prompt = vi.fn(() => reply.promise);
	const dispose = vi.fn(async () => {});
	let connectionListener: ((change: ConnectionStateChange) => void) | undefined;
	const removeConnectionListener = vi.fn();
	const removeAttachmentListener = vi.fn();
	const server = {
		route: { serverId: "server" },
		client: {
			onConnectionStateChange(listener: (change: ConnectionStateChange) => void) {
				connectionListener = listener;
				return removeConnectionListener;
			},
			onAttachmentChange: () => removeAttachmentListener,
		},
		directory: { state: { value: { sessions: [{ sessionId: "session" }] } } },
		plugins: { prepareSession: async () => {} },
		management: { attach: async () => {} },
		agent: { prompt },
		transcript: { state: transcript },
	};
	runtimeMocks.open.mockResolvedValue({ servers: [server], dispose });
	runtimeMocks.activate.mockResolvedValue(server);
	return {
		reply,
		prompt,
		dispose,
		removeConnectionListener,
		removeAttachmentListener,
		publish(event: LaneWatchEvent) {
			transcript.change(BACKGROUND_CONTEXT, (draft) => {
				draft.event = event;
			});
		},
		disconnect(error: Error) {
			connectionListener?.({ state: "disconnected", error });
		},
	};
}

function terminalEvent(runId = "run"): LaneWatchEvent {
	return { type: "run_end", lane: "main", runId, status: "completed", fromTipId: null, tipId: null, endedAt: 20 };
}

describe("experimental client prompt completion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each(["before", "after"])("delivers the terminal event %s the RPC reply before disposing", async (order) => {
		const runtime = createRuntime();
		const callback = deferred<void>();
		const seen: string[] = [];
		const result = runClient(
			{ command: "client", sessionId: "session", prompt: "question" },
			{
				onEvent: async (event) => {
					if (event.type === "run_end" && event.runId === "run") await callback.promise;
					seen.push(event.type);
				},
			},
		);
		await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledOnce());
		runtime.publish(terminalEvent("another-run"));
		runtime.publish({
			type: "message_end",
			lane: "main",
			runId: "run",
			message: JSON.parse(JSON.stringify(fauxAssistantMessage("answer"))) as Extract<
				LaneWatchEvent,
				{ type: "message_end" }
			>["message"],
		});
		if (order === "before") runtime.publish(terminalEvent());
		runtime.reply.resolve({ accepted: true, operationId: "run", error: null });
		await setImmediate();
		expect(runtime.dispose).not.toHaveBeenCalled();
		if (order === "after") runtime.publish(terminalEvent());
		await setImmediate();
		expect(runtime.dispose).not.toHaveBeenCalled();
		callback.resolve();

		await expect(result).resolves.toMatchObject({ kind: "prompted", text: "answer" });
		expect(seen.at(-1)).toBe("run_end");
		expect(runtime.dispose).toHaveBeenCalledOnce();
		expect(runtime.removeConnectionListener).toHaveBeenCalledOnce();
		expect(runtime.removeAttachmentListener).toHaveBeenCalledOnce();
	});

	it("reports a disconnect while terminal delivery is pending", async () => {
		const runtime = createRuntime();
		const result = runClient({ command: "client", sessionId: "session", prompt: "question" });
		const rejected = expect(result).rejects.toThrow("transport closed");
		await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledOnce());
		runtime.reply.resolve({ accepted: true, operationId: "run", error: null });
		await setImmediate();
		runtime.disconnect(new Error("transport closed"));
		await rejected;
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("reports presentation errors without waiting indefinitely for a terminal event", async () => {
		const runtime = createRuntime();
		const result = runClient(
			{ command: "client", sessionId: "session", prompt: "question" },
			{
				onEvent: () => {
					throw new Error("presentation failed");
				},
			},
		);
		const rejected = expect(result).rejects.toThrow("presentation failed");
		await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledOnce());
		runtime.reply.resolve({ accepted: true, operationId: "run", error: null });
		runtime.publish(terminalEvent());
		await rejected;
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("returns a rejected prompt without requiring a run event", async () => {
		const runtime = createRuntime();
		runtime.reply.resolve({ accepted: false, operationId: null, error: { code: "lane_busy", message: "busy" } });
		await expect(runClient({ command: "client", sessionId: "session", prompt: "question" })).rejects.toThrow("busy");
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});
});

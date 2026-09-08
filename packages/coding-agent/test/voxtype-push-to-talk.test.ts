import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	type CommandRunner,
	type DictationBackend,
	parseVoxTypeState,
	VoxTypeBackend,
} from "../examples/extensions/voxtype-push-to-talk/backend.ts";
import {
	type DictationControllerCallbacks,
	HoldToDictateController,
} from "../examples/extensions/voxtype-push-to-talk/controller.ts";
import { VoxTypeEditor } from "../examples/extensions/voxtype-push-to-talk/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";

function createHarness(overrides: Partial<DictationBackend> = {}) {
	const backend: DictationBackend = {
		probe: vi.fn(async () => true),
		start: vi.fn(async () => undefined),
		stop: vi.fn(async () => "dictated text"),
		cancel: vi.fn(async () => undefined),
		...overrides,
	};
	const callbacks: DictationControllerCallbacks = {
		insertSpace: vi.fn(),
		insertTranscript: vi.fn(),
		setStatus: vi.fn(),
		reportError: vi.fn(),
	};
	return { backend, callbacks, controller: new HoldToDictateController(backend, callbacks, 500) };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("HoldToDictateController", () => {
	it("inserts one space when released before the hold threshold", () => {
		const { backend, callbacks, controller } = createHarness();
		controller.press();
		vi.advanceTimersByTime(499);
		controller.release();

		expect(callbacks.insertSpace).toHaveBeenCalledOnce();
		expect(backend.start).not.toHaveBeenCalled();
	});

	it("commits a pending tap before subsequent input", () => {
		const { backend, callbacks, controller } = createHarness();
		controller.press();
		controller.beforeOtherInput();
		controller.release();

		expect(callbacks.insertSpace).toHaveBeenCalledOnce();
		expect(backend.start).not.toHaveBeenCalled();
	});

	it("records after the threshold and inserts the transcription on release", async () => {
		const { backend, callbacks, controller } = createHarness();
		controller.press();
		await vi.advanceTimersByTimeAsync(500);
		controller.release();
		await vi.runAllTimersAsync();

		expect(backend.start).toHaveBeenCalledOnce();
		expect(backend.stop).toHaveBeenCalledOnce();
		expect(callbacks.insertSpace).not.toHaveBeenCalled();
		expect(callbacks.insertTranscript).toHaveBeenCalledWith("dictated text");
	});

	it("ends recording before forwarding another input", async () => {
		const { backend, controller } = createHarness();
		controller.press();
		await vi.advanceTimersByTimeAsync(500);
		controller.beforeOtherInput();
		await vi.runAllTimersAsync();

		expect(backend.stop).toHaveBeenCalledOnce();
	});

	it("stops after startup finishes when Space was released during startup", async () => {
		let finishStart: (() => void) | undefined;
		const start = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishStart = resolve;
				}),
		);
		const { backend, callbacks, controller } = createHarness({ start });
		controller.press();
		await vi.advanceTimersByTimeAsync(500);
		controller.release();
		finishStart?.();
		await vi.runAllTimersAsync();

		expect(backend.stop).toHaveBeenCalledOnce();
		expect(callbacks.insertTranscript).toHaveBeenCalledWith("dictated text");
	});

	it("restores a space and reports the error when startup fails", async () => {
		const { callbacks, controller } = createHarness({ start: vi.fn(async () => Promise.reject(new Error("busy"))) });
		controller.press();
		await vi.advanceTimersByTimeAsync(500);
		controller.release();

		expect(callbacks.reportError).toHaveBeenCalledWith("busy");
		expect(callbacks.insertSpace).toHaveBeenCalledOnce();
	});

	it("cancels an owned recording during shutdown", async () => {
		const { backend, controller } = createHarness();
		controller.press();
		await vi.advanceTimersByTimeAsync(500);
		await controller.dispose();

		expect(backend.cancel).toHaveBeenCalledTimes(2);
		expect(backend.stop).not.toHaveBeenCalled();
	});
});

describe("VoxTypeEditor", () => {
	it("consumes non-dictation key releases", () => {
		const keybindings = new KeybindingsManager();
		const { controller } = createHarness();
		const editor = new VoxTypeEditor(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			keybindings,
			controller,
		);

		editor.handleInput("a");
		editor.handleInput("\x1b[97;1:3u");
		expect(editor.getText()).toBe("a");
	});
});

describe("VoxTypeBackend ownership", () => {
	it("cancels when recording starts but acknowledgement fails", async () => {
		const runtimeDirectory = await mkdtemp(join(tmpdir(), "pi-voxtype-test-"));
		let statusCalls = 0;
		let cancelCalls = 0;
		const run: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "status") {
				statusCalls++;
				if (statusCalls === 2) return { stdout: "", stderr: "status failed", code: 1, killed: false };
				return { stdout: '{"class":"idle"}', stderr: "", code: 0, killed: false };
			}
			if (args[1] === "cancel") cancelCalls++;
			return { stdout: "", stderr: "", code: 0, killed: false };
		});
		const backend = new VoxTypeBackend(run, runtimeDirectory);

		await expect(backend.start()).rejects.toThrow("status failed");
		expect(cancelCalls).toBe(1);

		await rm(runtimeDirectory, { recursive: true, force: true });
	});

	it("retains the process lock when stop and cancellation both fail", async () => {
		const runtimeDirectory = await mkdtemp(join(tmpdir(), "pi-voxtype-test-"));
		let state = "idle";
		let allowCancellation = false;
		const run: CommandRunner = vi.fn(async (_command, args) => {
			if (args[0] === "status") {
				return { stdout: JSON.stringify({ class: state }), stderr: "", code: 0, killed: false };
			}
			if (args[1] === "start") {
				state = "recording";
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			if (args[1] === "stop") return { stdout: "", stderr: "stop failed", code: 1, killed: false };
			if (allowCancellation) {
				state = "idle";
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "cancel failed", code: 1, killed: false };
		});
		const backend = new VoxTypeBackend(run, runtimeDirectory);
		await backend.start();
		await expect(backend.stop()).rejects.toThrow("stop failed");

		const competingBackend = new VoxTypeBackend(run, runtimeDirectory);
		await expect(competingBackend.start()).rejects.toThrow("already in use");

		allowCancellation = true;
		await backend.cancel();
		await rm(runtimeDirectory, { recursive: true, force: true });
	});
});

describe("parseVoxTypeState", () => {
	it("reads VoxType JSON status output", () => {
		expect(parseVoxTypeState('{"class":"recording"}')).toBe("recording");
		expect(parseVoxTypeState('{"alt":"idle"}')).toBe("idle");
		expect(parseVoxTypeState("not json")).toBeUndefined();
	});
});

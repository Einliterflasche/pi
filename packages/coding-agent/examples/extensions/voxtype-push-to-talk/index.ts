import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	isKeyRelease,
	isKeyRepeat,
	supportsKeyReleaseEvents,
	type TUI,
} from "@earendil-works/pi-tui";
import { VoxTypeBackend } from "./backend.ts";
import { HoldToDictateController } from "./controller.ts";

const STATUS_KEY = "voxtype-dictation";
const HOLD_THRESHOLD_MS = 500;
const NEGOTIATION_GRACE_MS = 200;

async function waitForKeyReleaseSupport(): Promise<boolean> {
	const deadline = Date.now() + NEGOTIATION_GRACE_MS;
	while (!supportsKeyReleaseEvents() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return supportsKeyReleaseEvents();
}

export class VoxTypeEditor extends CustomEditor {
	readonly wantsKeyRelease = true;
	private voiceKeybindings: KeybindingsManager;
	private controller: HoldToDictateController;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, controller: HoldToDictateController) {
		super(tui, theme, keybindings);
		this.voiceKeybindings = keybindings;
		this.controller = controller;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) {
			if (this.voiceKeybindings.matches(data, "app.voice.dictate")) this.controller.release();
			return;
		}
		if (!this.voiceKeybindings.matches(data, "app.voice.dictate")) {
			this.controller.beforeOtherInput();
			super.handleInput(data);
			return;
		}
		if (isKeyRepeat(data)) {
			if (!this.controller.repeat()) super.handleInput(data);
			return;
		}
		this.controller.press();
	}
}

export default function voxtypePushToTalk(pi: ExtensionAPI): void {
	let controller: HoldToDictateController | undefined;
	let voiceKeybindings: KeybindingsManager | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;

	pi.registerCommand("voxtype-status", {
		description: "Show whether hold-to-dictate is available",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("VoxType hold-to-dictate is available only in TUI mode", "warning");
				return;
			}
			if (!supportsKeyReleaseEvents()) {
				ctx.ui.notify("The terminal does not report key release events", "warning");
				return;
			}
			const backend = new VoxTypeBackend((command, args, options) => pi.exec(command, args, options));
			ctx.ui.notify(
				(await backend.probe())
					? "VoxType hold-to-dictate is ready"
					: "VoxType is not installed or its daemon is not running",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || ctx.ui.getEditorComponent()) return;
		const backend = new VoxTypeBackend((command, args, options) => pi.exec(command, args, options));
		if (!(await backend.probe()) || !(await waitForKeyReleaseSupport())) return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			let editor: VoxTypeEditor;
			voiceKeybindings = keybindings;
			controller = new HoldToDictateController(
				backend,
				{
					insertSpace: () => editor.insertTextAtCursor(" "),
					insertTranscript: (text) => ctx.ui.pasteToEditor(text),
					setStatus: (status) => {
						const labels = {
							starting: "voice: starting",
							recording: "voice: recording",
							transcribing: "voice: transcribing",
						} as const;
						ctx.ui.setStatus(STATUS_KEY, status ? ctx.ui.theme.fg("accent", labels[status]) : undefined);
					},
					reportError: (message) => ctx.ui.notify(`VoxType: ${message}`, "error"),
				},
				HOLD_THRESHOLD_MS,
			);
			editor = new VoxTypeEditor(tui, theme, keybindings, controller);
			return editor;
		});
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			if (!controller?.isActive() || !voiceKeybindings?.matches(data, "app.voice.dictate") || !isKeyRelease(data)) {
				return undefined;
			}
			controller.release();
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		voiceKeybindings = undefined;
		await controller?.dispose();
		controller = undefined;
	});
}

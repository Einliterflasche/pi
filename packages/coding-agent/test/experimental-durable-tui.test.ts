import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { DurableController, DurableView } from "../src/experimental/durable/runtime.ts";
import { runDurableTui } from "../src/experimental/durable/tui.ts";
import { runDurableTui as runVacationTui } from "../src/experimental/vacation/tui.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

it.each([
	["durable", runDurableTui],
	["vacation", runVacationTui],
] as const)("%s renders tokens and known costs when model or tool billing is unavailable", async (_name, runTui) => {
	const durable = await openFauxConversation();
	const state = await durable.conversation.viewState(BACKGROUND_CONTEXT);
	const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: null } satisfies Usage;
	const known = {
		...usage,
		input: 15,
		cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, source: "reported" },
	} satisfies Usage;
	const view: DurableView = {
		session: { id: "test", directory: process.cwd(), cwd: process.cwd() },
		conversation: {
			...state.value,
			docs: { ...state.value.docs, "pi.usage": { models: { unknown: usage, known }, tools: { unknown: usage } } },
		},
		conversations: [],
		models: [],
		notices: [],
	};
	const controller: DurableController = {
		submit: vi.fn(),
		compact: vi.fn(),
		abort: vi.fn(),
		cycleThinking: vi.fn(),
		setModel: vi.fn(),
		toggleTasks: vi.fn(),
		switchConversation: vi.fn(),
	};
	let ui: TuiAltScreen | undefined;
	vi.spyOn(TuiAltScreen.prototype, "start").mockImplementation(function (this: TuiAltScreen) {
		ui = this;
	});
	vi.spyOn(TuiAltScreen.prototype, "stop").mockImplementation(() => {});
	vi.spyOn(TuiAltScreen.prototype, "requestRender").mockImplementation(() => {});
	const unsubscribe = vi.fn();
	const running = runTui(
		{ current: () => view, subscribe: () => unsubscribe },
		controller,
		SettingsManager.inMemory({ theme: "dark" }),
	);
	try {
		expect(ui).toBeDefined();
		const rendered = ui!.render(160).join("\n");
		expect(rendered).toContain("↑35 ↓6 R9 W12 $1.000");
	} finally {
		ui?.getFocusedComponent()?.handleInput?.("\u0004");
		try {
			await running;
			expect(unsubscribe).toHaveBeenCalledOnce();
		} finally {
			vi.restoreAllMocks();
			state.dispose();
			await durable.close();
		}
	}
});

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, JsonlStorage, toStored } from "@earendil-works/pi-agent-core/experimental/pico3";
import { fauxAssistantMessage, type UsageCost } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createPicoModels } from "../src/experimental/micro/models.ts";
import { openMicro } from "../src/experimental/micro/runtime.ts";
import { selectSession } from "../src/experimental/micro/sessions.ts";

vi.mock("../src/experimental/micro/sessions.ts", () => ({ selectSession: vi.fn() }));

it("restores micro usage with unknown, reported, and estimated costs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-micro-usage-"));
	const path = join(cwd, "session");
	await mkdir(path);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
	vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory());
	onTestFinished(() => {
		vi.restoreAllMocks();
	});
	vi.mocked(selectSession).mockResolvedValue({
		id: "test",
		path,
		cwd,
		created: false,
		release: async () => {},
	});

	const storage = await JsonlStorage.open(path);
	const harness = await Harness.open(storage, { models: createPicoModels(runtime, new Map()) }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT);
		const costs: Array<UsageCost | null> = [
			null,
			{ input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3, source: "reported" },
			{ input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.7, source: "estimated" },
		];
		for (const cost of costs) {
			const message = fauxAssistantMessage("answer");
			message.usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost };
			await root.write({ kind: "test.assistant", model: [toStored(message)] }, BACKGROUND_CONTEXT);
		}
		await root.write(
			{
				kind: "test.usage",
				data: { usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: null } },
			},
			BACKGROUND_CONTEXT,
		);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}

	const micro = await openMicro({ cwd, continueSession: true });
	onTestFinished(() => micro.close());
	expect(micro.view.current().usage).toMatchObject({
		input: 35,
		output: 6,
		totalCost: 1,
		contextTokens: 12,
	});
	expect(micro.view.current().notices).toEqual([]);
});

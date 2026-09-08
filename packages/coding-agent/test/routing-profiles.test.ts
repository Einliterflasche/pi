import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("OpenRouter routing profiles", () => {
	let session: AgentSession;

	beforeEach(async () => {
		const openRouterModel = getModel("openrouter", "anthropic/claude-3-haiku");
		const anthropicModel = getModel("anthropic", "claude-fable-5");
		if (!openRouterModel || !anthropicModel) throw new Error("Required test models are unavailable");

		const authStorage = AuthStorage.inMemory({
			openrouter: { type: "api_key", key: "openrouter-key" },
			anthropic: { type: "api_key", key: "anthropic-key" },
		});
		const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(authStorage));
		const agent = new Agent({
			initialState: {
				model: openRouterModel,
				systemPrompt: "test",
				tools: [],
			},
			streamFn: streamSimple,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
			scopedModels: [{ model: openRouterModel }, { model: anthropicModel }],
		});
	});

	afterEach(() => {
		session.dispose();
	});

	it("retains a profile across direct provider switches without applying it outside OpenRouter", async () => {
		expect(session.cycleRoutingProfile()).toBe("fast");
		expect(session.getActiveRoutingOverride()).toEqual(session.getRoutingProfiles().fast);

		const anthropicModel = session.scopedModels[1].model;
		await session.setModel(anthropicModel);

		expect(session.getActiveRoutingProfile()).toBe("fast");
		expect(session.isRoutingProfilesSupported()).toBe(false);
		expect(session.getActiveRoutingOverride()).toBeUndefined();

		const openRouterModel = session.scopedModels[0].model;
		await session.setModel(openRouterModel);

		expect(session.getActiveRoutingProfile()).toBe("fast");
		expect(session.getActiveRoutingOverride()).toEqual(session.getRoutingProfiles().fast);
	});

	it("retains a profile across scoped model cycling", async () => {
		expect(session.cycleRoutingProfile()).toBe("fast");

		await session.cycleModel();
		expect(session.model?.provider).toBe("anthropic");
		expect(session.getActiveRoutingProfile()).toBe("fast");
		expect(session.getActiveRoutingOverride()).toBeUndefined();

		await session.cycleModel();
		expect(session.model?.provider).toBe("openrouter");
		expect(session.getActiveRoutingProfile()).toBe("fast");
		expect(session.getActiveRoutingOverride()).toEqual(session.getRoutingProfiles().fast);
	});
});

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createAgentSession provider headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-provider-headers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(provider: string, baseUrl: string): Model<Api> {
		return {
			id: `${provider}-test-model`,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureHeaders(
		model: Model<Api>,
		options: {
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
		} = {},
	): Promise<ProviderHeaders | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const registeredProviders = ["capture-provider"];
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider("capture-provider", {
			api: "openai-completions",
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		if (options.providerHeaders) {
			modelRegistry.registerProvider(model.provider, { headers: options.providerHeaders });
			registeredProviders.push(model.provider);
		}

		const sessionManager = SessionManager.inMemory(cwd);
		if (options.sessionId) {
			sessionManager.newSession({ id: options.sessionId });
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			await session.agent.streamFn(
				model,
				{ messages: [] },
				{
					sessionId: session.sessionId,
					...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
				},
			);
			return capturedOptions?.headers;
		} finally {
			session.dispose();
			for (const provider of registeredProviders.reverse()) {
				modelRegistry.unregisterProvider(provider);
			}
		}
	}

	it.each([
		["openrouter", "https://openrouter.ai/api/v1"],
		["nvidia", "https://integrate.api.nvidia.com/v1"],
		["cloudflare-workers-ai", "https://api.cloudflare.com/client/v4/accounts/test/ai/v1"],
	])("does not add telemetry attribution headers for %s", async (provider, baseUrl) => {
		const headers = await captureHeaders(createModel(provider, baseUrl));

		expect(headers?.["HTTP-Referer"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Title"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Categories"]).toBeUndefined();
		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
		expect(headers?.["User-Agent"]).toBeUndefined();
	});

	it("merges configured provider and request headers", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: {
				"HTTP-Referer": "https://provider.example",
				"X-Custom-Header": "provider",
			},
			requestHeaders: {
				"X-Custom-Header": "request",
			},
		});

		expect(headers?.["HTTP-Referer"]).toBe("https://provider.example");
		expect(headers?.["X-Custom-Header"]).toBe("request");
	});

	it("adds OpenCode session headers", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(headers?.["x-opencode-session"]).toBe("opencode-session");
		expect(headers?.["x-opencode-client"]).toBeUndefined();
	});

	it("lets configured OpenCode headers override session defaults", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
				"x-opencode-client": "configured-client",
			},
		});

		expect(headers?.["x-opencode-session"]).toBe("configured-session");
		expect(headers?.["x-opencode-client"]).toBe("configured-client");
	});
});

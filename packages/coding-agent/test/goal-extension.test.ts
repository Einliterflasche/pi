import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension, {
	type GoalState,
	parseGoalEvaluation,
	parseGoalStart,
} from "../examples/extensions/goal/index.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

function latestGoalState(harness: Harness): GoalState | null {
	const entries = harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "goal-state");
	const latest = entries[entries.length - 1];
	if (!latest || latest.type !== "custom") return null;
	return (latest.data as { state: GoalState | null }).state;
}

async function bindHarness(
	harness: Harness,
	mode: "tui" | "print" = "tui",
	onStatus?: (text: string | undefined) => void,
): Promise<void> {
	await harness.session.bindExtensions({
		mode,
		uiContext: onStatus
			? ({
					setStatus: (_key: string, text: string | undefined) => onStatus(text),
					notify: () => {},
				} as unknown as ExtensionUIContext)
			: undefined,
		commandContextActions: {
			waitForIdle: () => harness.session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		},
	});
}

describe("goal extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("parses limits and strict evaluator output", () => {
		expect(parseGoalStart("--turns 4 --tokens 12000 --minutes 5 finish the migration")).toEqual({
			objective: "finish the migration",
			maxTurns: 4,
			maxTokens: 12000,
			maxMinutes: 5,
		});
		expect(
			parseGoalEvaluation(
				'```json\n{"complete":false,"madeProgress":true,"blocked":false,"progress":"tests added","reason":"one test fails","hint":"the failure names a missing fixture"}\n```',
			),
		).toEqual({
			complete: false,
			madeProgress: true,
			blocked: false,
			progress: "tests added",
			reason: "one test fails",
			hint: "the failure names a missing fixture",
		});
		expect(parseGoalStart("finish the migration")).toEqual({
			objective: "finish the migration",
			maxTurns: null,
			maxTokens: null,
			maxMinutes: null,
		});
		expect(() => parseGoalStart("--turns 0 objective")).toThrow("positive integer");
		expect(() => parseGoalEvaluation('{"complete":true}')).toThrow("required schema");
	});

	it("continues with custom provenance and completes using the active model and thinking level", async () => {
		let evaluatorModel = "";
		let evaluatorReasoning: unknown;
		const statuses: Array<string | undefined> = [];
		const harness = await createHarness({
			models: [{ id: "goal-model", reasoning: true }],
			extensionFactories: [goalExtension],
		});
		harnesses.push(harness);
		await bindHarness(harness, "tui", (text) => statuses.push(text));
		harness.session.setThinkingLevel("high");
		harness.session.enablePermissions(undefined, "auto-read-only");
		harness.setResponses([
			fauxAssistantMessage("implemented part one"),
			(_context, options, _state, model) => {
				evaluatorModel = model.id;
				evaluatorReasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
				return fauxAssistantMessage(
					'{"complete":false,"madeProgress":true,"blocked":false,"progress":"part one implemented","reason":"verification remains","hint":"the project check command also runs type checking"}',
				);
			},
			fauxAssistantMessage("verification passed"),
			fauxAssistantMessage(
				'{"complete":true,"madeProgress":true,"blocked":false,"progress":"implemented and verified","reason":"all requested work is verified"}',
			),
		]);

		await harness.session.prompt("/goal implement and verify the feature");
		await harness.session.waitForIdle();

		const state = latestGoalState(harness);
		expect(state?.status).toBe("completed");
		expect(state?.turns).toBe(2);
		expect(state?.lastEvaluation?.evaluator).toEqual({
			provider: "faux",
			model: "goal-model",
			thinkingLevel: "high",
		});
		expect(evaluatorModel).toBe("goal-model");
		expect(evaluatorReasoning).toBe("high");
		expect(statuses.some((text) => text?.startsWith("goal evaluating…"))).toBe(true);
		expect(statuses.at(-1)).toBeUndefined();
		expect(harness.session.permissionMode).toBe("auto-read-only");
		expect((harness.session as unknown as { _permissionUserMessages: string[] })._permissionUserMessages).toContain(
			"/goal implement and verify the feature",
		);
		expect(getUserTexts(harness)).toEqual([]);
		const continuations = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "goal_continuation");
		expect(continuations).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("waits for the goal loop in headless mode", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);
		await bindHarness(harness, "print");
		harness.setResponses([
			fauxAssistantMessage("finished immediately"),
			fauxAssistantMessage(
				'{"complete":true,"madeProgress":true,"blocked":false,"progress":"done","reason":"the objective is complete"}',
			),
		]);

		await harness.session.prompt("/goal finish once");

		expect(latestGoalState(harness)?.status).toBe("completed");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("discards a stale evaluation before slow input preprocessing finishes", async () => {
		let releaseEvaluation = () => {};
		const evaluationReleased = new Promise<void>((resolve) => {
			releaseEvaluation = resolve;
		});
		let markEvaluationStarted = () => {};
		const evaluationStarted = new Promise<void>((resolve) => {
			markEvaluationStarted = resolve;
		});
		let releaseInput = () => {};
		const inputReleased = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let markInputStarted = () => {};
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_received", async (event) => {
						if (event.text !== "Use the alternate solution") return;
						markInputStarted();
						await inputReleased;
					});
				},
				goalExtension,
			],
		});
		harnesses.push(harness);
		await bindHarness(harness);
		harness.setResponses([
			fauxAssistantMessage("initial work"),
			async () => {
				markEvaluationStarted();
				await evaluationReleased;
				return fauxAssistantMessage(
					'{"complete":false,"madeProgress":true,"blocked":false,"progress":"stale","reason":"stale work remains"}',
				);
			},
			fauxAssistantMessage("user-directed work completed"),
			fauxAssistantMessage(
				'{"complete":true,"madeProgress":true,"blocked":false,"progress":"done","reason":"the latest work completes the objective"}',
			),
		]);

		await harness.session.prompt("/goal finish the task");
		await evaluationStarted;
		const userPrompt = harness.session.prompt("Use the alternate solution");
		await inputStarted;
		releaseEvaluation();
		await new Promise((resolve) => setTimeout(resolve, 0));
		releaseInput();
		await userPrompt;
		await harness.session.waitForIdle();

		expect(latestGoalState(harness)?.status).toBe("completed");
		const continuations = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "goal_continuation");
		expect(continuations).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("allows tool use within the final agent run before evaluation", async () => {
		const harness = await createHarness({
			extensionFactories: [goalExtension],
			tools: [
				{
					name: "verify",
					label: "Verify",
					description: "Verify completion",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "verified" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		await bindHarness(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("verify", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("verification finished"),
			fauxAssistantMessage(
				'{"complete":true,"madeProgress":true,"blocked":false,"progress":"verified","reason":"verification proves completion"}',
			),
		]);

		await harness.session.prompt("/goal --turns 1 verify the task");
		await harness.session.waitForIdle();

		expect(latestGoalState(harness)?.status).toBe("completed");
		expect(latestGoalState(harness)?.turns).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("evaluates the final allowed turn, then pauses without starting another turn", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);
		await bindHarness(harness);
		harness.setResponses([
			fauxAssistantMessage("attempted the task"),
			fauxAssistantMessage(
				'{"complete":false,"madeProgress":true,"blocked":false,"progress":"partial","reason":"work remains"}',
			),
		]);

		await harness.session.prompt("/goal --turns 1 finish the task");
		await harness.session.waitForIdle();

		const state = latestGoalState(harness);
		expect(state?.status).toBe("paused");
		expect(state?.pauseReason).toBe("turn limit reached");
		expect(state?.lastEvaluation?.reason).toBe("work remains");
		expect(state?.turns).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		const continuations = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "goal_continuation");
		expect(continuations).toHaveLength(1);
	});

	it("pauses after three consecutive evaluations without progress", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);
		await bindHarness(harness);
		harness.setResponses([
			fauxAssistantMessage("attempt one"),
			fauxAssistantMessage(
				'{"complete":false,"madeProgress":false,"blocked":false,"progress":"unchanged","reason":"no verified progress"}',
			),
			fauxAssistantMessage("attempt two"),
			fauxAssistantMessage(
				'{"complete":false,"madeProgress":false,"blocked":false,"progress":"unchanged","reason":"no verified progress"}',
			),
			fauxAssistantMessage("attempt three"),
			fauxAssistantMessage(
				'{"complete":false,"madeProgress":false,"blocked":false,"progress":"unchanged","reason":"no verified progress"}',
			),
		]);

		await harness.session.prompt("/goal solve the stalled problem");
		await harness.session.waitForIdle();

		const state = latestGoalState(harness);
		expect(state?.status).toBe("paused");
		expect(state?.noProgressCount).toBe(3);
		expect(state?.pauseReason).toBe("no material progress across 3 evaluations");
		expect(state?.maxTurns).toBeNull();
		expect(state?.maxTokens).toBeNull();
		expect(state?.maxMinutes).toBeNull();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("pauses when the evaluator reports the same blocker twice", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);
		await bindHarness(harness);
		harness.setResponses([
			fauxAssistantMessage("requested access"),
			fauxAssistantMessage(
				'{"complete":false,"madeProgress":true,"blocked":true,"progress":"access requested","reason":"required credentials are unavailable"}',
			),
			fauxAssistantMessage("checked for credentials again"),
			fauxAssistantMessage(
				'{"complete":false,"madeProgress":true,"blocked":true,"progress":"access remains unavailable","reason":"required credentials are unavailable"}',
			),
		]);

		await harness.session.prompt("/goal deploy the service");
		await harness.session.waitForIdle();

		const state = latestGoalState(harness);
		expect(state?.status).toBe("paused");
		expect(state?.repeatedBlockerCount).toBe(2);
		expect(state?.pauseReason).toBe("repeated blocker: required credentials are unavailable");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores paused state in a resumed session", async () => {
		let releaseFirstTurn = () => {};
		const firstTurnReleased = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve;
		});
		let markFirstTurnStarted = () => {};
		const firstTurnStarted = new Promise<void>((resolve) => {
			markFirstTurnStarted = resolve;
		});
		const sessionManager = SessionManager.inMemory();
		const firstHarness = await createHarness({ extensionFactories: [goalExtension], sessionManager });
		harnesses.push(firstHarness);
		firstHarness.session.enablePermissions(undefined, "auto-read-only");
		await bindHarness(firstHarness);
		firstHarness.setResponses([
			async () => {
				markFirstTurnStarted();
				await firstTurnReleased;
				return fauxAssistantMessage("first attempt");
			},
		]);

		await firstHarness.session.prompt("/goal finish safely");
		await firstTurnStarted;
		await firstHarness.session.prompt("/goal pause");
		releaseFirstTurn();
		await firstHarness.session.waitForIdle();
		expect(latestGoalState(firstHarness)?.status).toBe("paused");
		expect(latestGoalState(firstHarness)?.turns).toBe(1);

		const resumedHarness = await createHarness({
			extensionFactories: [goalExtension],
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		harnesses.push(resumedHarness);
		resumedHarness.session.enablePermissions(undefined, "auto-read-only");
		await bindHarness(resumedHarness);
		expect(
			(resumedHarness.session as unknown as { _permissionUserMessages: string[] })._permissionUserMessages,
		).toContain("/goal finish safely");
		resumedHarness.setResponses([
			fauxAssistantMessage("resumed work"),
			fauxAssistantMessage(
				'{"complete":true,"madeProgress":true,"blocked":false,"progress":"done","reason":"objective is complete"}',
			),
		]);

		await resumedHarness.session.prompt("/goal resume");
		await resumedHarness.session.waitForIdle();
		expect(latestGoalState(resumedHarness)?.status).toBe("completed");
		expect(latestGoalState(resumedHarness)?.turns).toBe(2);
	});
});

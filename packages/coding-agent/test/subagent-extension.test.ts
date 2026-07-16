import { describe, expect, it } from "vitest";
import { type AgentConfig, discoverBuiltinAgents } from "../examples/extensions/subagent/agents.ts";
import { buildSubagentArgs, resolveSubagentPermissionMode } from "../examples/extensions/subagent/index.ts";

const worker: AgentConfig = {
	name: "worker",
	description: "General worker",
	systemPrompt: "Work on the task.",
	source: "builtin",
	filePath: "/agents/worker.md",
};

describe("subagent extension", () => {
	it("maps manual parent permissions to read-only and inherits every other mode", () => {
		expect(resolveSubagentPermissionMode("manual")).toBe("read-only");
		for (const mode of ["read-only", "auto-read-only", "auto", "skip"] as const) {
			expect(resolveSubagentPermissionMode(mode)).toBe(mode);
		}
	});

	it("inherits model, thinking level, and permission mode for child invocations", () => {
		expect(
			buildSubagentArgs(worker, {
				model: "openai/gpt-5.6-sol",
				thinkingLevel: "high",
				permissionMode: "auto-read-only",
			}),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--permission-mode",
			"auto-read-only",
			"--exclude-tools",
			"subagent",
			"--model",
			"openai/gpt-5.6-sol",
			"--thinking",
			"high",
		]);
	});

	it("keeps explicit agent model and tool overrides", () => {
		expect(
			buildSubagentArgs(
				{ ...worker, model: "anthropic/claude-haiku-4-5", tools: ["read", "grep"] },
				{
					model: "openai/gpt-5.6-sol",
					thinkingLevel: "max",
					permissionMode: "read-only",
				},
			),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--permission-mode",
			"read-only",
			"--exclude-tools",
			"subagent",
			"--model",
			"anthropic/claude-haiku-4-5",
			"--tools",
			"read,grep",
		]);
	});

	it("ships built-in agents that inherit the parent model", () => {
		const agents = discoverBuiltinAgents();
		expect(agents.map(({ name }) => name).sort()).toEqual(["planner", "reviewer", "scout", "worker"]);
		expect(agents.every(({ source, model }) => source === "builtin" && model === undefined)).toBe(true);
	});
});

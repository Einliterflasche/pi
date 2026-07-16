import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { buildForkRelaunchArgs } from "../src/main.ts";
import {
	buildZellijForkPaneArgs,
	getCurrentCliInvocation,
	isZellijAvailable,
	openForkInZellij,
} from "../src/modes/interactive/zellij-fork.ts";
import { spawnProcess } from "../src/utils/child-process.ts";

describe("Zellij fork helpers", () => {
	it("relaunches Node and development entrypoints with their runtime arguments", () => {
		expect(
			getCurrentCliInvocation({
				bunBinary: false,
				execPath: "/usr/bin/node",
				execArgv: ["--import", "tsx"],
				entrypoint: "/repo/src/cli.ts",
			}),
		).toEqual({
			command: "/usr/bin/node",
			args: ["--import", "tsx", "/repo/src/cli.ts"],
		});
	});

	it("relaunches a compiled Bun binary directly", () => {
		expect(getCurrentCliInvocation({ bunBinary: true, execPath: "/usr/bin/pi" })).toEqual({
			command: "/usr/bin/pi",
			args: [],
		});
	});

	it("falls back to the application name without an entrypoint", () => {
		expect(
			getCurrentCliInvocation({ bunBinary: false, execPath: "/usr/bin/node", entrypoint: null, appName: "tau" }),
		).toEqual({ command: "tau", args: [] });
	});

	it("requires both a Zellij session and an available binary", () => {
		const checkBinary = vi.fn(() => true);
		expect(isZellijAvailable({}, checkBinary)).toBe(false);
		expect(checkBinary).not.toHaveBeenCalled();
		expect(isZellijAvailable({ ZELLIJ: "0" }, checkBinary)).toBe(true);
		expect(checkBinary).toHaveBeenCalledOnce();
		expect(isZellijAvailable({ ZELLIJ: "0" }, () => false)).toBe(false);
	});

	it("preserves runtime flags while dropping session selection and prompt arguments", () => {
		const parsed = parseArgs([
			"--session",
			"old-session",
			"--session-dir",
			"/sessions",
			"--name",
			"old name",
			"--model",
			"anthropic/opus",
			"--permission-mode",
			"auto-read-only",
			"--extension",
			"./extension.ts",
			"--no-skills",
			"--custom-flag",
			"value",
			"prompt to drop",
		]);

		expect(
			buildForkRelaunchArgs(parsed, {
				extensions: ["/repo/extension.ts"],
			}),
		).toEqual([
			"--model",
			"anthropic/opus",
			"--permission-mode",
			"auto-read-only",
			"--extension",
			"/repo/extension.ts",
			"--no-skills",
			"--custom-flag",
			"value",
		]);
	});

	it("removes the editor handoff when pane creation fails", async () => {
		let editorTextFile: string | undefined;
		await expect(
			openForkInZellij(
				{
					cwd: "/repo",
					sessionFile: "/sessions/fork.jsonl",
					selectedText: "cleanup test",
					relaunchArgs: [],
				},
				(args) => {
					editorTextFile = args.at(-1);
					return spawnProcess(process.execPath, ["-e", "process.stderr.write('pane failed'); process.exit(1)"], {
						stdio: ["ignore", "ignore", "pipe"],
					});
				},
			),
		).rejects.toThrow("pane failed");
		expect(editorTextFile).toBeTruthy();
		expect(existsSync(editorTextFile!)).toBe(false);
	});

	it("builds a same-tab new-pane command with the fork handoff", () => {
		expect(
			buildZellijForkPaneArgs({
				cwd: "/repo",
				sessionFile: "/sessions/fork.jsonl",
				editorTextFile: "/tmp/pi-fork-editor.txt",
				relaunchArgs: ["--model", "anthropic/opus", "--no-skills"],
				invocation: { command: "/usr/bin/node", args: ["/pkg/dist/cli.js"] },
			}),
		).toEqual([
			"action",
			"new-pane",
			"--cwd",
			"/repo",
			"--",
			"/usr/bin/node",
			"/pkg/dist/cli.js",
			"--model",
			"anthropic/opus",
			"--no-skills",
			"--session",
			"/sessions/fork.jsonl",
			"--initial-editor-text-file",
			"/tmp/pi-fork-editor.txt",
		]);
	});
});

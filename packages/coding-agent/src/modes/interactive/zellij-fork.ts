import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { APP_NAME, isBunBinary } from "../../config.ts";
import { createForkEditorTextFile } from "../../core/fork-handoff.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "../../utils/child-process.ts";

export interface CliInvocation {
	command: string;
	args: string[];
}

export function getCurrentCliInvocation(
	options: {
		bunBinary?: boolean;
		execPath?: string;
		execArgv?: readonly string[];
		entrypoint?: string | null;
		appName?: string;
	} = {},
): CliInvocation {
	const execPath = options.execPath ?? process.execPath;
	if (options.bunBinary ?? isBunBinary) {
		return { command: execPath, args: [] };
	}

	const entrypoint = options.entrypoint === null ? undefined : (options.entrypoint ?? process.argv[1]);
	if (entrypoint) {
		return {
			command: execPath,
			args: [...(options.execArgv ?? process.execArgv), entrypoint],
		};
	}

	return { command: options.appName ?? APP_NAME, args: [] };
}

export function isZellijAvailable(
	env: NodeJS.ProcessEnv = process.env,
	checkBinary: () => boolean = () => {
		const result = spawnProcessSync("zellij", ["--version"], {
			encoding: "utf8",
			stdio: "ignore",
		});
		return result.status === 0;
	},
): boolean {
	return env.ZELLIJ !== undefined && checkBinary();
}

export function buildZellijForkPaneArgs(options: {
	cwd: string;
	sessionFile: string;
	editorTextFile: string;
	relaunchArgs: readonly string[];
	invocation?: CliInvocation;
}): string[] {
	const invocation = options.invocation ?? getCurrentCliInvocation();
	return [
		"action",
		"new-pane",
		"--cwd",
		options.cwd,
		"--",
		invocation.command,
		...invocation.args,
		...options.relaunchArgs,
		"--session",
		options.sessionFile,
		"--initial-editor-text-file",
		options.editorTextFile,
	];
}

export async function openForkInZellij(
	options: {
		cwd: string;
		sessionFile: string;
		selectedText: string;
		relaunchArgs: readonly string[];
	},
	spawnPane: (args: string[]) => ChildProcess = (args) =>
		spawnProcess("zellij", args, { stdio: ["ignore", "ignore", "pipe"] }),
): Promise<void> {
	const editorTextFile = createForkEditorTextFile(options.selectedText);
	let paneCreated = false;

	try {
		const child = spawnPane(
			buildZellijForkPaneArgs({
				cwd: options.cwd,
				sessionFile: options.sessionFile,
				editorTextFile,
				relaunchArgs: options.relaunchArgs,
			}),
		);
		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		const exitCode = await waitForChildProcess(child);
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `zellij exited with code ${exitCode ?? "unknown"}`);
		}
		paneCreated = true;

		// The child consumes this file during startup. Clean up eventually if the
		// pane command fails before pi gets that far.
		const cleanupTimer = setTimeout(() => rmSync(editorTextFile, { force: true }), 30_000);
		cleanupTimer.unref();
	} finally {
		if (!paneCreated) {
			rmSync(editorTextFile, { force: true });
		}
	}
}

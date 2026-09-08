import { constants } from "node:fs";
import { access, type FileHandle, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VoxTypeState = "idle" | "recording" | "transcribing" | "stopped";

export type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

export type CommandRunner = (
	command: string,
	args: string[],
	options?: { timeout?: number; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface DictationBackend {
	probe(): Promise<boolean>;
	start(): Promise<void>;
	stop(): Promise<string>;
	cancel(): Promise<void>;
}

const COMMAND_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 3_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;

function errorMessage(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `voxtype exited with code ${result.code}`;
}

export function parseVoxTypeState(output: string): VoxTypeState | undefined {
	try {
		const value = JSON.parse(output) as { class?: unknown; alt?: unknown };
		const state = typeof value.class === "string" ? value.class : value.alt;
		if (state === "idle" || state === "recording" || state === "transcribing" || state === "stopped") {
			return state;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export class VoxTypeBackend implements DictationBackend {
	private run: CommandRunner;
	private lockPath: string;
	private lockHandle: FileHandle | undefined;
	private tempDirectory: string | undefined;
	private outputPath: string | undefined;
	private ownsRecording = false;

	constructor(run: CommandRunner, runtimeDirectory = process.env.XDG_RUNTIME_DIR || tmpdir()) {
		this.run = run;
		this.lockPath = join(runtimeDirectory, "pi-voxtype-push-to-talk.lock");
	}

	async probe(): Promise<boolean> {
		try {
			return (await this.status()) !== "stopped";
		} catch {
			return false;
		}
	}

	async start(): Promise<void> {
		await this.acquireLock();
		try {
			const state = await this.status();
			if (state !== "idle") throw new Error(`VoxType is ${state}`);

			this.tempDirectory = await mkdtemp(join(tmpdir(), "pi-voxtype-"));
			this.outputPath = join(this.tempDirectory, "transcript.txt");
			const result = await this.run("voxtype", ["record", "start", `--file=${this.outputPath}`], {
				timeout: COMMAND_TIMEOUT_MS,
			});
			if (result.code !== 0 || result.killed) throw new Error(errorMessage(result));

			this.ownsRecording = true;
			await this.waitForState("recording", START_TIMEOUT_MS);
		} catch (error) {
			if (this.ownsRecording) {
				await this.cancel().catch(() => undefined);
			} else {
				await this.cleanup();
			}
			throw error;
		}
	}

	async stop(): Promise<string> {
		if (!this.ownsRecording) throw new Error("VoxType recording is not owned by this Pi process");
		try {
			const result = await this.run("voxtype", ["record", "stop"], { timeout: COMMAND_TIMEOUT_MS });
			if (result.code !== 0 || result.killed) throw new Error(errorMessage(result));
			await this.waitForState("idle", TRANSCRIPTION_TIMEOUT_MS);
			let transcript = "";
			if (this.outputPath) {
				try {
					await access(this.outputPath, constants.R_OK);
					transcript = await readFile(this.outputPath, "utf8");
				} catch {
					// VAD and empty recordings intentionally produce no output file.
				}
			}
			this.ownsRecording = false;
			await this.cleanup();
			return transcript;
		} catch (error) {
			await this.cancel().catch(() => undefined);
			throw error;
		}
	}

	async cancel(): Promise<void> {
		if (!this.ownsRecording) {
			await this.cleanup();
			return;
		}
		if (!(await this.requestCancellation())) throw new Error("Failed to cancel the VoxType recording");
		this.ownsRecording = false;
		await this.cleanup();
	}

	private async status(): Promise<VoxTypeState> {
		const result = await this.run("voxtype", ["status", "--format", "json"], { timeout: COMMAND_TIMEOUT_MS });
		if (result.code !== 0 || result.killed) throw new Error(errorMessage(result));
		const state = parseVoxTypeState(result.stdout);
		if (!state) throw new Error("VoxType returned an invalid status response");
		return state;
	}

	private async waitForState(expected: VoxTypeState, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if ((await this.status()) === expected) return;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		throw new Error(`Timed out waiting for VoxType to become ${expected}`);
	}

	private async acquireLock(): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				this.lockHandle = await open(this.lockPath, "wx", 0o600);
				try {
					await this.lockHandle.writeFile(String(process.pid));
				} catch (error) {
					await this.cleanup();
					throw error;
				}
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (attempt > 0 || !(await this.removeStaleLock())) {
					throw new Error("VoxType is already in use by another Pi process");
				}
			}
		}
	}

	private async requestCancellation(): Promise<boolean> {
		try {
			const result = await this.run("voxtype", ["record", "cancel"], { timeout: COMMAND_TIMEOUT_MS });
			if (result.code !== 0 || result.killed) return false;
			await this.waitForState("idle", START_TIMEOUT_MS);
			return true;
		} catch {
			return false;
		}
	}

	private async removeStaleLock(): Promise<boolean> {
		try {
			const pid = Number.parseInt(await readFile(this.lockPath, "utf8"), 10);
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(pid, 0);
					return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
				}
			}
			await unlink(this.lockPath);
			return true;
		} catch {
			return false;
		}
	}

	private async cleanup(): Promise<void> {
		await this.lockHandle?.close().catch(() => undefined);
		this.lockHandle = undefined;
		await unlink(this.lockPath).catch(() => undefined);
		if (this.tempDirectory) await rm(this.tempDirectory, { recursive: true, force: true });
		this.tempDirectory = undefined;
		this.outputPath = undefined;
	}
}

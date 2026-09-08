import type { DictationBackend } from "./backend.ts";

export type DictationControllerCallbacks = {
	insertSpace(): void;
	insertTranscript(text: string): void;
	setStatus(status: "starting" | "recording" | "transcribing" | undefined): void;
	reportError(message: string): void;
};

type ControllerState = "idle" | "armed" | "starting" | "start-failed" | "recording" | "stopping" | "disposed";

export class HoldToDictateController {
	private backend: DictationBackend;
	private callbacks: DictationControllerCallbacks;
	private holdMs: number;
	private state: ControllerState = "idle";
	private disposed = false;
	private holdTimer: ReturnType<typeof setTimeout> | undefined;
	private releasedWhileStarting = false;
	private operation: Promise<void> | undefined;

	constructor(backend: DictationBackend, callbacks: DictationControllerCallbacks, holdMs = 500) {
		this.backend = backend;
		this.callbacks = callbacks;
		this.holdMs = holdMs;
	}

	press(): boolean {
		if (this.state !== "idle") return true;
		this.state = "armed";
		this.releasedWhileStarting = false;
		this.holdTimer = setTimeout(() => {
			this.holdTimer = undefined;
			this.operation = this.startRecording();
		}, this.holdMs);
		return true;
	}

	repeat(): boolean {
		return this.state !== "idle";
	}

	isActive(): boolean {
		return this.state !== "idle" && this.state !== "disposed";
	}

	beforeOtherInput(): void {
		if (this.state === "armed" || this.state === "start-failed") {
			if (this.holdTimer) clearTimeout(this.holdTimer);
			this.holdTimer = undefined;
			this.state = "idle";
			this.callbacks.insertSpace();
			return;
		}
		if (this.state === "starting") {
			this.releasedWhileStarting = true;
			return;
		}
		if (this.state === "recording") this.operation = this.stopRecording();
	}

	release(): boolean {
		if (this.state === "idle" || this.state === "disposed") return false;
		if (this.state === "armed" || this.state === "start-failed") {
			if (this.holdTimer) clearTimeout(this.holdTimer);
			this.holdTimer = undefined;
			this.state = "idle";
			this.callbacks.insertSpace();
			return true;
		}
		if (this.state === "starting") {
			this.releasedWhileStarting = true;
			return true;
		}
		if (this.state === "recording") {
			this.operation = this.stopRecording();
		}
		return true;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.holdTimer) clearTimeout(this.holdTimer);
		this.holdTimer = undefined;
		const previousState = this.state;
		this.state = "disposed";
		this.callbacks.setStatus(undefined);
		if (previousState === "recording") await this.backend.cancel().catch(() => undefined);
		await this.operation?.catch(() => undefined);
		await this.backend.cancel();
	}

	private async startRecording(): Promise<void> {
		if (this.state !== "armed") return;
		this.state = "starting";
		this.callbacks.setStatus("starting");
		try {
			await this.backend.start();
		} catch (error) {
			if (this.disposed) return;
			this.state = this.releasedWhileStarting ? "idle" : "start-failed";
			this.callbacks.setStatus(undefined);
			this.callbacks.reportError(error instanceof Error ? error.message : String(error));
			if (this.releasedWhileStarting) this.callbacks.insertSpace();
			return;
		}

		if (this.disposed) {
			await this.backend.cancel();
			return;
		}
		this.state = "recording";
		this.callbacks.setStatus("recording");
		if (this.releasedWhileStarting) await this.stopRecording();
	}

	private async stopRecording(): Promise<void> {
		if (this.state !== "recording") return;
		this.state = "stopping";
		this.callbacks.setStatus("transcribing");
		try {
			const transcript = await this.backend.stop();
			if (!this.disposed && transcript.length > 0) this.callbacks.insertTranscript(transcript);
		} catch (error) {
			if (!this.disposed) {
				let message = error instanceof Error ? error.message : String(error);
				try {
					await this.backend.cancel();
				} catch (cancelError) {
					const cancellationMessage = cancelError instanceof Error ? cancelError.message : String(cancelError);
					message = `${message}; ${cancellationMessage}`;
				}
				this.callbacks.reportError(message);
			}
		} finally {
			if (!this.disposed) {
				this.state = "idle";
				this.callbacks.setStatus(undefined);
			}
		}
	}
}

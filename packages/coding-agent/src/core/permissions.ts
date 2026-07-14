export type PermissionMode = "manual" | "skip" | "auto";

export type ClassifierResult = { approved: true } | { approved: false; reason: string };

export interface PermissionRequest {
	toolName: string;
	args: unknown;
	userMessages: string[];
	cwd: string;
	/** Defaults to true for the built-in read and grep tools. */
	exempt?: boolean;
}

export interface PermissionDecision {
	approved: boolean;
	reason?: string;
	escalated?: boolean;
}

export interface PermissionControllerOptions {
	mode?: PermissionMode;
	classify: (request: PermissionRequest, signal?: AbortSignal) => Promise<ClassifierResult>;
	requestApproval?: (request: PermissionRequest, reason: string | undefined, signal?: AbortSignal) => Promise<boolean>;
	retryDelay?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

const EXEMPT_TOOLS = new Set(["read", "grep"]);
const MAX_CLASSIFIER_RETRIES = 3;
const MAX_CONSECUTIVE_REJECTIONS = 5;

function waitForRetry(attempt: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Permission classification aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Permission classification aborted"));
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			200 * 2 ** attempt,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function parseClassifierResult(text: string): ClassifierResult {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new Error("Classifier returned invalid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Classifier returned an invalid response shape");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (record.approved === true && keys.length === 1) {
		return { approved: true };
	}
	if (
		record.approved === false &&
		keys.length === 2 &&
		keys.includes("reason") &&
		typeof record.reason === "string" &&
		record.reason.trim().length > 0
	) {
		return { approved: false, reason: record.reason.trim() };
	}
	throw new Error("Classifier response does not match the permission schema");
}

export class PermissionController {
	private mode: PermissionMode;
	private classify: PermissionControllerOptions["classify"];
	private requestApproval: PermissionControllerOptions["requestApproval"];
	private retryDelay: NonNullable<PermissionControllerOptions["retryDelay"]>;
	private consecutiveClassifierRejections = 0;
	private awaitingUserApproval = false;

	constructor(options: PermissionControllerOptions) {
		this.mode = options.mode ?? "manual";
		this.classify = options.classify;
		this.requestApproval = options.requestApproval;
		this.retryDelay = options.retryDelay ?? waitForRetry;
	}

	getMode(): PermissionMode {
		return this.mode;
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
		this.consecutiveClassifierRejections = 0;
		this.awaitingUserApproval = false;
	}

	setApprovalHandler(handler: PermissionControllerOptions["requestApproval"]): void {
		this.requestApproval = handler;
	}

	onUserMessage(): void {
		this.consecutiveClassifierRejections = 0;
		this.awaitingUserApproval = false;
	}

	async evaluate(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
		if ((EXEMPT_TOOLS.has(request.toolName) && request.exempt !== false) || this.mode === "skip") {
			return { approved: true };
		}

		if (this.awaitingUserApproval) {
			return {
				approved: false,
				escalated: true,
				reason:
					"Tool execution remains paused after five consecutive permission denials. Explain what you are trying to do, why this access is necessary, and ask the user for explicit approval before proposing more tools.",
			};
		}

		if (this.mode === "manual") {
			return await this.askUser(request, undefined, signal);
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_CLASSIFIER_RETRIES; attempt++) {
			try {
				const result = await this.classify(request, signal);
				if (result.approved) {
					this.consecutiveClassifierRejections = 0;
					return { approved: true };
				}

				this.consecutiveClassifierRejections++;
				if (this.consecutiveClassifierRejections >= MAX_CONSECUTIVE_REJECTIONS) {
					this.awaitingUserApproval = true;
					return {
						approved: false,
						escalated: true,
						reason: `${result.reason}\n\nFive consecutive tool calls were denied by the permission classifier. Stop proposing tools, explain what you are trying to accomplish and why this access is necessary, then ask the user for explicit approval.`,
					};
				}
				return { approved: false, reason: result.reason };
			} catch (error) {
				if (signal?.aborted) throw error;
				lastError = error;
				if (attempt < MAX_CLASSIFIER_RETRIES) {
					await this.retryDelay(attempt, signal);
				}
			}
		}

		const failure = lastError instanceof Error ? lastError.message : String(lastError);
		return await this.askUser(request, `Permission classifier failed after four attempts: ${failure}`, signal);
	}

	private async askUser(
		request: PermissionRequest,
		reason: string | undefined,
		signal?: AbortSignal,
	): Promise<PermissionDecision> {
		if (!this.requestApproval) {
			return { approved: false, reason: reason ?? "Tool execution requires interactive approval" };
		}
		const approved = await this.requestApproval(request, reason, signal);
		return approved ? { approved: true } : { approved: false, reason: reason ?? "Tool execution denied by user" };
	}
}

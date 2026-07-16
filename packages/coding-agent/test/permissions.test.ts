import { describe, expect, it, vi } from "vitest";
import { PermissionController, type PermissionRequest, parseClassifierResult } from "../src/core/permissions.ts";

const request: PermissionRequest = {
	toolName: "bash",
	args: { command: "echo hi" },
	userMessages: ["run the command"],
	cwd: "/tmp/project",
};

describe("parseClassifierResult", () => {
	it("accepts only the strict discriminated union", () => {
		expect(parseClassifierResult('{"approved":true}')).toEqual({ approved: true });
		expect(parseClassifierResult('{"approved":false,"reason":"too broad"}')).toEqual({
			approved: false,
			reason: "too broad",
		});
		expect(() => parseClassifierResult('{"approved":true,"reason":"unused"}')).toThrow();
		expect(() => parseClassifierResult('{"approved":false}')).toThrow();
		expect(() => parseClassifierResult("```json\n{}\n```")).toThrow();
	});
});

describe("PermissionController", () => {
	it("permits verified built-in read and grep without prompting", async () => {
		const classify = vi.fn();
		const requestApproval = vi.fn();
		const controller = new PermissionController({ classify, requestApproval });

		await expect(controller.evaluate({ ...request, toolName: "read", builtin: true })).resolves.toEqual({
			approved: true,
		});
		await expect(controller.evaluate({ ...request, toolName: "grep", builtin: true })).resolves.toEqual({
			approved: true,
		});
		expect(classify).not.toHaveBeenCalled();
		expect(requestApproval).not.toHaveBeenCalled();

		await controller.evaluate({ ...request, toolName: "read", builtin: false });
		expect(requestApproval).toHaveBeenCalledTimes(1);
	});

	it("prompts for each non-exempt tool in manual mode", async () => {
		const requestApproval = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const controller = new PermissionController({ classify: vi.fn(), requestApproval });

		await expect(controller.evaluate(request)).resolves.toEqual({ approved: true });
		await expect(controller.evaluate(request)).resolves.toEqual({
			approved: false,
			reason: "Tool execution denied by user",
		});
		expect(requestApproval).toHaveBeenCalledTimes(2);
	});

	it("permits only verified read-only built-ins in read-only mode without prompting", async () => {
		const classify = vi.fn();
		const requestApproval = vi.fn();
		const controller = new PermissionController({ mode: "read-only", classify, requestApproval });

		for (const toolName of ["read", "grep", "find", "ls"]) {
			await expect(controller.evaluate({ ...request, toolName, builtin: true })).resolves.toEqual({
				approved: true,
			});
		}

		const overriddenRead = await controller.evaluate({ ...request, toolName: "read", builtin: false });
		expect(overriddenRead.approved).toBe(false);
		expect(overriddenRead.reason).toContain("verified built-in");

		const bash = await controller.evaluate({ ...request, toolName: "bash", builtin: true });
		expect(bash.approved).toBe(false);
		expect(bash.reason).toContain("ask the user to switch");
		expect(classify).not.toHaveBeenCalled();
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it("permits every tool in skip mode", async () => {
		const classify = vi.fn();
		const controller = new PermissionController({ mode: "skip", classify });

		await expect(controller.evaluate(request)).resolves.toEqual({ approved: true });
		expect(classify).not.toHaveBeenCalled();
	});

	it("uses strict classifier decisions in auto mode", async () => {
		const classify = vi
			.fn()
			.mockResolvedValueOnce({ approved: true })
			.mockResolvedValueOnce({ approved: false, reason: "too broad" });
		const controller = new PermissionController({ mode: "auto", classify });

		await expect(controller.evaluate(request)).resolves.toEqual({ approved: true });
		await expect(controller.evaluate(request)).resolves.toEqual({ approved: false, reason: "too broad" });
	});

	it("uses classifier decisions in automatic read-only mode", async () => {
		const classify = vi
			.fn()
			.mockResolvedValueOnce({ approved: true })
			.mockResolvedValueOnce({ approved: false, reason: "not verifiably read-only" });
		const requestApproval = vi.fn();
		const controller = new PermissionController({ mode: "auto-read-only", classify, requestApproval });

		const write = await controller.evaluate({ ...request, toolName: "write", builtin: true });
		expect(write.approved).toBe(false);
		expect(write.reason).toContain("inherently altering");
		expect(classify).not.toHaveBeenCalled();

		await expect(controller.evaluate(request)).resolves.toEqual({ approved: true });
		await expect(controller.evaluate(request)).resolves.toEqual({
			approved: false,
			reason: "not verifiably read-only",
		});
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it("denies automatic read-only calls when classification fails", async () => {
		const classify = vi.fn().mockRejectedValue(new Error("offline"));
		const requestApproval = vi.fn();
		const retryDelay = vi.fn().mockResolvedValue(undefined);
		const controller = new PermissionController({
			mode: "auto-read-only",
			classify,
			requestApproval,
			retryDelay,
		});

		const decision = await controller.evaluate(request);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("could not be verified as non-altering");
		expect(classify).toHaveBeenCalledTimes(4);
		expect(retryDelay).toHaveBeenCalledTimes(3);
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it("retries classifier failures three times before manual fallback", async () => {
		const classify = vi.fn().mockRejectedValue(new Error("offline"));
		const requestApproval = vi.fn().mockResolvedValue(true);
		const retryDelay = vi.fn().mockResolvedValue(undefined);
		const controller = new PermissionController({ mode: "auto", classify, requestApproval, retryDelay });

		await expect(controller.evaluate(request)).resolves.toEqual({ approved: true });
		expect(classify).toHaveBeenCalledTimes(4);
		expect(retryDelay).toHaveBeenCalledTimes(3);
		expect(requestApproval).toHaveBeenCalledWith(
			request,
			"Permission classifier failed after four attempts: offline",
			undefined,
		);
	});

	it("does not retry user cancellation", async () => {
		const abortController = new AbortController();
		const classify = vi.fn().mockImplementation(async () => {
			abortController.abort();
			throw new Error("cancelled");
		});
		const controller = new PermissionController({ mode: "auto", classify });

		await expect(controller.evaluate(request, abortController.signal)).rejects.toThrow("cancelled");
		expect(classify).toHaveBeenCalledTimes(1);
	});

	it("pauses after five consecutive classifier rejections until a user message", async () => {
		const classify = vi.fn().mockResolvedValue({ approved: false, reason: "unexpected access" });
		const controller = new PermissionController({ mode: "auto", classify });

		for (let index = 0; index < 4; index++) {
			const decision = await controller.evaluate(request);
			expect(decision.escalated).toBeUndefined();
		}
		const fifth = await controller.evaluate(request);
		expect(fifth).toMatchObject({ approved: false, escalated: true });
		expect(fifth.reason).toContain("ask the user for explicit approval");

		const latched = await controller.evaluate(request);
		expect(latched).toMatchObject({ approved: false, escalated: true });
		expect(classify).toHaveBeenCalledTimes(5);

		controller.onUserMessage();
		const afterUserMessage = await controller.evaluate(request);
		expect(afterUserMessage.escalated).toBeUndefined();
		expect(classify).toHaveBeenCalledTimes(6);
	});

	it("classifier failures and exempt calls do not alter a rejection streak", async () => {
		const classify = vi
			.fn()
			.mockResolvedValueOnce({ approved: false, reason: "no" })
			.mockRejectedValueOnce(new Error("bad schema"))
			.mockResolvedValueOnce({ approved: true })
			.mockResolvedValue({ approved: false, reason: "no" });
		const controller = new PermissionController({
			mode: "auto",
			classify,
			requestApproval: vi.fn().mockResolvedValue(false),
			retryDelay: vi.fn().mockResolvedValue(undefined),
		});

		await controller.evaluate(request);
		await controller.evaluate({ ...request, toolName: "read", builtin: true });
		await controller.evaluate(request);
		for (let index = 0; index < 4; index++) {
			await controller.evaluate(request);
		}
		const fifthAfterApprovalReset = await controller.evaluate(request);
		expect(fifthAfterApprovalReset.escalated).toBe(true);
	});
});

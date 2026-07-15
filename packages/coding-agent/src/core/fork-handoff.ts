import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const FORK_EDITOR_FILE_PREFIX = "pi-fork-editor-";

export function createForkEditorTextFile(text: string): string {
	const filePath = join(tmpdir(), `${FORK_EDITOR_FILE_PREFIX}${randomUUID()}.txt`);
	writeFileSync(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return filePath;
}

export function consumeForkEditorTextFile(filePath: string): string {
	const resolvedPath = resolve(filePath);
	if (dirname(resolvedPath) !== resolve(tmpdir()) || !basename(resolvedPath).startsWith(FORK_EDITOR_FILE_PREFIX)) {
		throw new Error("Invalid fork editor handoff path");
	}

	try {
		return readFileSync(resolvedPath, "utf8");
	} finally {
		rmSync(resolvedPath, { force: true });
	}
}

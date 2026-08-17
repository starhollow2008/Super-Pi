// changelog.ts — Silently records every file edit/write this session as a
// timestamped, diffed log entry (independent of pi's own /changelog, which
// shows pi's release notes). View the collected history with /filelog.
//
//   /filelog            — last 20 file changes, newest first
//   /filelog all        — everything recorded this session
//   /filelog 5          — last 5 changes
//   /filelog auth.ts    — only changes touching paths containing "auth.ts"
//
// Install:
//   Global (all projects):  ~/.pi/agent/extensions/changelog.ts
//   Project-local:           .pi/extensions/changelog.ts
//   Quick test:               pi -e ./changelog.ts

import type { ExtensionAPI, WriteToolInput } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Minimal dependency-free line diff (LCS-based). Only emits changed lines
 * (no context, no headers) — compact enough for a changelog entry without
 * needing an external diff library. Falls back to a one-line summary for
 * very large files rather than paying for an O(n*m) table.
 */
function diffLines(oldText: string, newText: string): string {
	const a = oldText.length > 0 ? oldText.split("\n") : [];
	const b = newText.length > 0 ? newText.split("\n") : [];

	if (a.length * b.length > 4_000_000) {
		return `- (${a.length} lines removed — diff too large to render)\n+ (${b.length} lines added — diff too large to render)`;
	}

	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		const dpRowI = dp[i] as number[];
		const dpRowI1 = dp[i + 1] as number[];
		for (let j = m - 1; j >= 0; j--) {
			dpRowI[j] = a[i] === b[j] ? (dpRowI1[j + 1] as number) + 1 : Math.max(dpRowI1[j] as number, dpRowI[j + 1] as number);
		}
	}

	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if ((dp[i + 1] as number[])[j]! >= (dp[i] as number[])[j + 1]!) {
			out.push(`-${a[i]}`);
			i++;
		} else {
			out.push(`+${b[j]}`);
			j++;
		}
	}
	while (i < n) {
		out.push(`-${a[i]}`);
		i++;
	}
	while (j < m) {
		out.push(`+${b[j]}`);
		j++;
	}
	return out.join("\n");
}

interface Theme {
	fg(token: string, text: string): string;
	bold(text: string): string;
}

interface LogEntry {
	timestamp: string;
	tool: "edit" | "write";
	path: string;
	patch: string;
	added: number;
	removed: number;
}

const LOG_ENTRY_TYPE = "changelog-entry"; // silent, one per file change — powers /filelog
const VIEW_ENTRY_TYPE = "changelog-view"; // visible printout for a /filelog invocation
const COMMAND_NAME = "filelog";

function countChanges(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export default function (pi: ExtensionAPI) {
	// Pre-write file content, captured just before a write lands, so we can diff
	// against it once the tool result comes back (write itself reports no diff).
	const pendingWriteContent = new Map<string, string>();

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event)) return;
		const path = String(event.input.path ?? "");
		const abs = resolve(ctx.cwd, path);
		let before = "";
		try {
			if (existsSync(abs)) before = readFileSync(abs, "utf8");
		} catch {
			before = "";
		}
		pendingWriteContent.set(event.toolCallId, before);
	});

	pi.on("tool_result", async (event) => {
		if (isEditToolResult(event)) {
			if (event.isError || !event.details) return;
			const path = String(event.input.path ?? "");
			const { added, removed } = countChanges(event.details.patch);
			pi.appendEntry<LogEntry>(LOG_ENTRY_TYPE, {
				timestamp: new Date().toISOString(),
				tool: "edit",
				path,
				patch: event.details.patch,
				added,
				removed,
			});
			return;
		}

		if (isWriteToolResult(event)) {
			const input = event.input as unknown as WriteToolInput;
			const before = pendingWriteContent.get(event.toolCallId) ?? "";
			pendingWriteContent.delete(event.toolCallId);
			if (event.isError) return;

			const patch = diffLines(before, input.content);
			const { added, removed } = countChanges(patch);
			pi.appendEntry<LogEntry>(LOG_ENTRY_TYPE, {
				timestamp: new Date().toISOString(),
				tool: "write",
				path: input.path,
				patch,
				added,
				removed,
			});
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show recorded file changes: /filelog [n | path substring | all]",
		handler: async (args, ctx) => {
			const entries: LogEntry[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === LOG_ENTRY_TYPE) {
					entries.push(entry.data as LogEntry);
				}
			}
			entries.reverse(); // newest first

			const trimmed = args.trim();
			let filtered = entries;
			let limit = 20;
			if (trimmed) {
				if (trimmed.toLowerCase() === "all") {
					limit = entries.length;
				} else if (/^\d+$/.test(trimmed)) {
					limit = Number.parseInt(trimmed, 10);
				} else {
					filtered = entries.filter((e) => e.path.includes(trimmed));
					limit = filtered.length;
				}
			}
			filtered = filtered.slice(0, limit);

			pi.appendEntry(VIEW_ENTRY_TYPE, { entries: filtered });
			if (filtered.length === 0) {
				ctx.ui.notify("No matching file changes recorded yet.", "info");
			}
		},
	});

	pi.registerEntryRenderer(VIEW_ENTRY_TYPE, (entry: { data?: { entries?: LogEntry[] } }, options: { expanded: boolean }, theme: Theme) => {
		const list = entry.data?.entries ?? [];
		if (list.length === 0) {
			return new Text(theme.fg("dim", "No file changes recorded yet."), 1, 0);
		}

		const lines: string[] = [theme.fg("dim", `File changes (${list.length})`)];
		for (const item of list) {
			const stat = `${theme.fg("success", `+${item.added}`)} ${theme.fg("error", `-${item.removed}`)}`;
			const when = new Date(item.timestamp).toLocaleString();
			lines.push(`${theme.fg("muted", when)}  ${theme.bold(item.path)}  ${stat}  ${theme.fg("dim", `(${item.tool})`)}`);
			if (options.expanded) {
				lines.push(
					item.patch
						.split("\n")
						.map((l) => `  ${l}`)
						.join("\n"),
				);
			}
		}
		return new Text(lines.join("\n"), 1, 0);
	});
}

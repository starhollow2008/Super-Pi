// smart-edit.ts — Removes the "oldText must match character-for-character"
// requirement from the built-in edit tool. Before each edit call executes,
// this checks whether edits[].oldText is present verbatim in the target
// file; if not, it searches the file for the closest matching block (via a
// line-windowed Levenshtein similarity score) and rewrites oldText to that
// exact substring, so the real edit tool's own exact-match apply still
// succeeds. If no sufficiently close block exists, the call is left alone
// and the built-in tool reports its normal "not found" error.
//
// This works by patching the `tool_call` event's mutable `input` in place —
// pi explicitly supports this as the extension point for exactly this kind
// of pre-execution correction — rather than replacing the edit tool itself.
//
// A short note is appended to the tool result whenever a correction was
// applied, so the model (and you) can see it happened.
//
// Install:
//   Global (all projects):  ~/.pi/agent/extensions/smart-edit.ts
//   Project-local:           .pi/extensions/smart-edit.ts
//   Quick test:               pi -e ./smart-edit.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { resolve } from "path";

// Minimum similarity (0-1) a candidate block must reach to be accepted as a match.
const SIMILARITY_THRESHOLD = 0.6;

interface Correction {
	index: number;
	from: string;
	to: string;
}

function levenshtein(a: string, b: string): number {
	const al = a.length;
	const bl = b.length;
	if (al === 0) return bl;
	if (bl === 0) return al;

	let prev = new Array<number>(bl + 1);
	let curr = new Array<number>(bl + 1);
	for (let j = 0; j <= bl; j++) prev[j] = j;

	for (let i = 1; i <= al; i++) {
		curr[0] = i;
		for (let j = 1; j <= bl; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min((prev[j] as number) + 1, (curr[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[bl] as number;
}

function similarity(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	return 1 - levenshtein(a, b) / maxLen;
}

/** Find the block of `content` most similar to `target`, scanning line-aligned windows. */
function findClosestBlock(content: string, target: string): { text: string; score: number } | undefined {
	if (content.includes(target)) return { text: target, score: 1 };

	const fileLines = content.split("\n");
	const targetLineCount = Math.max(1, target.split("\n").length);

	let best: { text: string; score: number } | undefined;
	for (let start = 0; start <= fileLines.length - targetLineCount; start++) {
		const windowText = fileLines.slice(start, start + targetLineCount).join("\n");
		// Cheap pre-filter: skip windows whose length is wildly different before paying for Levenshtein.
		if (Math.abs(windowText.length - target.length) > Math.max(40, target.length * 0.5)) continue;
		const score = similarity(windowText, target);
		if (!best || score > best.score) best = { text: windowText, score };
	}
	return best;
}

export default function (pi: ExtensionAPI) {
	// toolCallId -> corrections applied, so tool_result can note it happened.
	const corrections = new Map<string, Correction[]>();

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event)) return;

		const abs = resolve(ctx.cwd, event.input.path);
		let content: string;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			return; // let the real tool report the read error
		}

		const applied: Correction[] = [];
		event.input.edits.forEach((edit, index) => {
			if (content.includes(edit.oldText)) return;
			const match = findClosestBlock(content, edit.oldText);
			if (match && match.score >= SIMILARITY_THRESHOLD && match.text !== edit.oldText) {
				applied.push({ index, from: edit.oldText, to: match.text });
				edit.oldText = match.text;
			}
		});

		if (applied.length > 0) {
			corrections.set(event.toolCallId, applied);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto-matched ${applied.length} edit${applied.length === 1 ? "" : "s"} in ${event.input.path} to the closest existing text.`,
					"info",
				);
			}
		}
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "edit") return;
		const applied = corrections.get(event.toolCallId);
		if (!applied || applied.length === 0) return;
		corrections.delete(event.toolCallId);
		if (event.isError) return;

		const note =
			applied.length === 1
				? "(Note: oldText didn't match exactly, so it was auto-corrected to the closest matching text in the file.)"
				: `(Note: ${applied.length} of your oldText values didn't match exactly, so they were auto-corrected to the closest matching text in the file.)`;

		return { content: [...event.content, { type: "text" as const, text: note }] };
	});
}

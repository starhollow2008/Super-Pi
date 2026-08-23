// ask.ts — Lets the model pause mid-task and ask the user a clarifying question
// instead of guessing, using pi's built-in dialog primitives (select / confirm /
// input). The answer comes back as the tool result, so the model can react to
// it in the same turn.
//
// Install:
//   Global (all projects):  ~/.pi/agent/extensions/ask.ts
//   Project-local:           .pi/extensions/ask.ts
//   Quick test:               pi -e ./ask.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "ask_user";

interface Theme {
	fg(token: string, text: string): string;
	bold(text: string): string;
}

interface AskParams {
	question: string;
	options?: string[];
	kind?: "choice" | "confirm" | "text";
}

interface AskDetails {
	answered: boolean;
	answer?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask",
		description:
			"Pause and ask the user a short clarifying question, then return their answer as this tool's result. " +
			"Use for genuine ambiguity that would otherwise send you down the wrong path or cause you to redo work — " +
			"not for routine confirmations you could reasonably make yourself.",
		promptSnippet: "Ask the user a clarifying question and wait for their answer",
		promptGuidelines: [
			"Prefer proceeding with a stated, reasonable assumption over asking — reserve this for ambiguity that would likely send you down the wrong path.",
			"Ask one question at a time; keep it short and specific.",
			"Pass 'options' (2-6 short choices) when the answer is naturally one of a few things, so the user can tap instead of typing.",
			"If the user dismisses the question without answering, proceed using your best judgment and say what you assumed.",
		],
		parameters: Type.Object({
			question: Type.String({
				minLength: 1,
				description: "The question to ask, phrased so a human can answer it quickly.",
			}),
			options: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "2-6 short choices to present as tappable options. Omit for free-form or yes/no questions.",
				}),
			),
			kind: Type.Optional(
				StringEnum(["choice", "confirm", "text"] as const, {
					description:
						"How to ask: 'choice' (pick one of options), 'confirm' (yes/no), or 'text' (free-form). " +
						"Inferred from 'options' when omitted.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: AskParams, _signal, _onUpdate, ctx) {
			const kind = params.kind ?? (params.options && params.options.length > 0 ? "choice" : "text");

			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No interactive user is available to answer right now. Proceed using your best judgment and state the assumption you're making.",
						},
					],
					details: { answered: false } satisfies AskDetails,
				};
			}

			if (kind === "confirm") {
				const yes = await ctx.ui.confirm("Question", params.question);
				const answer = yes ? "Yes" : "No";
				return { content: [{ type: "text" as const, text: answer }], details: { answered: true, answer } satisfies AskDetails };
			}

			if (kind === "choice" && params.options && params.options.length > 0) {
				// Options + a final writable "Other…" line for free-form answers
				const allOptions = [...params.options, "Other… (write your own)"];

				const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
					(tui, theme, _kb, done) => {
						let optionIndex = 0;
						let editMode = false;
						let cachedLines: string[] | undefined;

						const editorTheme: EditorTheme = {
							borderColor: (s) => theme.fg("accent", s),
							selectList: {
								selectedPrefix: (t) => theme.fg("accent", t),
								selectedText: (t) => theme.fg("accent", t),
								description: (t) => theme.fg("muted", t),
								scrollInfo: (t) => theme.fg("dim", t),
								noMatch: (t) => theme.fg("warning", t),
							},
						};
						const editor = new Editor(tui, editorTheme);

						editor.onSubmit = (value) => {
							const trimmed = value.trim();
							if (trimmed) {
								done({ answer: trimmed, wasCustom: true });
							} else {
								editMode = false;
								editor.setText("");
								refresh();
							}
						};

						function refresh() {
							cachedLines = undefined;
							tui.requestRender();
						}

						function handleInput(data: string) {
							if (editMode) {
								if (matchesKey(data, Key.escape)) {
									editMode = false;
									editor.setText("");
									refresh();
									return;
								}
								editor.handleInput(data);
								refresh();
								return;
							}

							if (matchesKey(data, Key.up)) {
								optionIndex = Math.max(0, optionIndex - 1);
								refresh();
								return;
							}
							if (matchesKey(data, Key.down)) {
								optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
								refresh();
								return;
							}

							if (matchesKey(data, Key.enter)) {
								if (optionIndex === allOptions.length - 1) {
									editMode = true;
									refresh();
								} else {
									done({ answer: allOptions[optionIndex], wasCustom: false, index: optionIndex + 1 });
								}
								return;
							}

							if (matchesKey(data, Key.escape)) {
								done(null);
							}
						}

						function render(width: number): string[] {
							if (cachedLines) return cachedLines;
							const lines: string[] = [];
							const w = Math.max(1, width);

							function addWrapped(text: string) {
								lines.push(...wrapTextWithAnsi(text, w));
							}
							function addWrappedWithPrefix(prefix: string, text: string) {
								const pw = visibleWidth(prefix);
								if (pw >= w) {
									addWrapped(prefix + text);
									return;
								}
								const wrapped = wrapTextWithAnsi(text, w - pw);
								const cont = " ".repeat(pw);
								for (let i = 0; i < wrapped.length; i++) {
									lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
								}
							}

							lines.push(theme.fg("accent", "─".repeat(w)));
							addWrappedWithPrefix(" ", theme.fg("text", params.question));
							lines.push("");

							for (let i = 0; i < allOptions.length; i++) {
								const selected = i === optionIndex;
								const isOther = i === allOptions.length - 1;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const label = `${i + 1}. ${allOptions[i]}${isOther && editMode ? " ✎" : ""}`;
								addWrappedWithPrefix(prefix, theme.fg(selected || (isOther && editMode) ? "accent" : "text", label));
							}

							if (editMode) {
								lines.push("");
								addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
								for (const line of editor.render(Math.max(1, w - 2))) {
									lines.push(` ${line}`);
								}
							}

							lines.push("");
							addWrappedWithPrefix(
								" ",
								theme.fg("dim", editMode ? "Enter to submit • Esc to go back" : "↑↓ navigate • Enter to select • Esc to cancel"),
							);
							lines.push(theme.fg("accent", "─".repeat(w)));

							cachedLines = lines;
							return lines;
						}

						return {
							render,
							invalidate: () => {
								cachedLines = undefined;
							},
							handleInput,
						};
					},
				);

				if (result === null) {
					return {
						content: [{ type: "text" as const, text: "The user dismissed the question without answering." }],
						details: { answered: false } satisfies AskDetails,
					};
				}
				return {
					content: [{ type: "text" as const, text: result.answer }],
					details: { answered: true, answer: result.answer } satisfies AskDetails,
				};
			}

			const text = await ctx.ui.input(params.question, "Type your answer...");
			if (text === undefined || text.trim() === "") {
				return {
					content: [{ type: "text" as const, text: "The user dismissed the question without answering." }],
					details: { answered: false } satisfies AskDetails,
				};
			}
			return { content: [{ type: "text" as const, text }], details: { answered: true, answer: text } satisfies AskDetails };
		},
		renderCall(args: { question?: string }, theme: Theme) {
			const label = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question ?? "");
			return new Text(label, 0, 0);
		},
		renderResult(result: { details?: AskDetails }, options: { isPartial?: boolean }, theme: Theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Waiting for an answer..."), 0, 0);
			}
			const answered = result.details?.answered;
			const text = answered
				? theme.fg("success", `Answered: ${result.details?.answer ?? ""}`)
				: theme.fg("dim", "No answer given.");
			return new Text(text, 0, 0);
		},
	});
}

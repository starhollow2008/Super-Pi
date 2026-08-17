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
import { Text } from "@earendil-works/pi-tui";
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
				const choice = await ctx.ui.select(params.question, params.options);
				if (choice === undefined) {
					return {
						content: [{ type: "text" as const, text: "The user dismissed the question without answering." }],
						details: { answered: false } satisfies AskDetails,
					};
				}
				return {
					content: [{ type: "text" as const, text: choice }],
					details: { answered: true, answer: choice } satisfies AskDetails,
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

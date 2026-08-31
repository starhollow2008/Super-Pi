// todo.ts — Task planning extension for pi
//
// Gives the model a `todo_write` tool for breaking multi-step work into a
// tracked checklist (pending / in_progress / completed / failed), plus:
//
//   /tasks          — print the current checklist + goal into the transcript
//   /edit           — open a free-text editor to add/remove/reorder/re-status tasks by hand
//   /task <n> <s>   — set task #n's status (pending | in_progress | completed/done | failed)
//   /task add <t>   — append a new pending task
//   /task rm <n>    — delete task #n
//   /task clear     — remove all tasks (keeps the goal)
//   /goal [text]    — show, set, or clear ("/goal clear") the session's overarching goal
//
// State (todos + goal) is persisted as a dedicated "todo-state" custom entry
// appended on every mutation — from the model's todo_write calls AND from the
// human commands above — so the checklist survives reload/resume/fork and
// reflects whichever source (agent or human) touched it last. A separate
// "todo-snapshot" entry (unchanged from before) is still used only for the
// visible /tasks printout.
//
// A persistent one-line progress widget lives above the editor. All colors
// come from the active theme's tokens, so the checklist automatically
// matches whatever theme is selected — including a custom one.
//
// Install:
//   Global (all projects):  ~/.pi/agent/extensions/todo.ts
//   Project-local:           .pi/extensions/todo.ts
//   Quick test:               pi -e ./todo.ts

import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed" | "failed";

interface Todo {
	content: string;
	activeForm: string;
	status: TodoStatus;
}

interface TodoState {
	todos: Todo[];
	goal?: string;
}

interface Theme {
	fg(token: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

const TOOL_NAME = "todo_write";
const EDIT_TOOL_NAME = "todo_edit";
const DONE_TOOL_NAME = "todo_done";
const COMMAND_NAME = "tasks";
const EDIT_COMMAND_NAME = "edit";
const TASK_COMMAND_NAME = "task";
const GOAL_COMMAND_NAME = "goal";
const ENTRY_TYPE = "todo-snapshot";
const STATE_ENTRY_TYPE = "todo-state";
const WIDGET_ID = "todo";

function progressPercent(todos: Todo[]): number {
	if (todos.length === 0) return 0;
	const settled = todos.filter((t) => t.status === "completed").length;
	// Failed tasks count as half-weight so a list ending in failure never reads as 100%.
	const failed = todos.filter((t) => t.status === "failed").length;
	return Math.round(((settled + failed * 0.5) / todos.length) * 100);
}

function progressBar(todos: Todo[], theme: Theme, width = 10): string {
	if (todos.length === 0) return "";
	const pct = progressPercent(todos);
	const filled = Math.round((pct / 100) * width);
	const chunks: string[] = [];
	for (let i = 0; i < width; i++) {
		chunks.push(i < filled ? theme.fg("success", "█") : theme.fg("dim", "░"));
	}
	return `${theme.fg("dim", "[")}${chunks.join("")}${theme.fg("dim", "]")}`;
}

function glyph(status: TodoStatus): string {
	if (status === "completed") return "✓";
	if (status === "in_progress") return "◐";
	if (status === "failed") return "✗";
	return "○";
}

function normalizeStatus(word: string): TodoStatus | undefined {
	const w = word.trim().toLowerCase();
	if (w === "pending" || w === "todo") return "pending";
	if (w === "in_progress" || w === "inprogress" || w === "progress" || w === "doing") return "in_progress";
	if (w === "completed" || w === "complete" || w === "done") return "completed";
	if (w === "failed" || w === "fail") return "failed";
	return undefined;
}

function renderChecklist(todos: Todo[], theme: Theme, goal?: string): string {
	const lines: string[] = [];
	if (goal) {
		lines.push(theme.fg("accent", theme.bold(`Goal: ${goal}`)));
	}

	if (todos.length === 0) {
		lines.push(theme.fg("dim", "No tasks yet."));
		return lines.join("\n");
	}

	const done = todos.filter((t) => t.status === "completed").length;
	const failed = todos.filter((t) => t.status === "failed").length;
	const pct = progressPercent(todos);
	const counts = failed > 0 ? `${done}/${todos.length} (${failed} failed)` : `${done}/${todos.length}`;
	lines.push(`${progressBar(todos, theme)} ${theme.fg("dim", `${counts} · ${pct}%`)}`);

	todos.forEach((todo, i) => {
		const label = glyph(todo.status);
		const num = theme.fg("dim", `${i + 1}.`);
		if (todo.status === "completed") {
			lines.push(`${num} ${theme.fg("success", `${label} ${theme.strikethrough(todo.content)}`)}`);
		} else if (todo.status === "in_progress") {
			lines.push(`${num} ${theme.fg("accent", theme.bold(`${label} ${todo.activeForm || todo.content}`))}`);
		} else if (todo.status === "failed") {
			lines.push(`${num} ${theme.fg("error", `${label} ${todo.content}`)}`);
		} else {
			lines.push(`${num} ${theme.fg("muted", `${label} ${todo.content}`)}`);
		}
	});

	return lines.join("\n");
}

function renderWidgetLine(todos: Todo[], theme: Theme, goal?: string): string {
	if (todos.length === 0 && !goal) return "";

	const goalLine = goal ? theme.fg("accent", `🎯 ${goal}`) : "";
	if (todos.length === 0) return goalLine;

	const done = todos.filter((t) => t.status === "completed").length;
	const failed = todos.filter((t) => t.status === "failed").length;
	const active = todos.find((t) => t.status === "in_progress");

	const bar = todos
		.map((t) => {
			if (t.status === "completed") return theme.fg("success", "●");
			if (t.status === "in_progress") return theme.fg("accent", "◐");
			if (t.status === "failed") return theme.fg("error", "✗");
			return theme.fg("dim", "○");
		})
		.join("");

	let label: string;
	if (active) {
		label = theme.fg("accent", active.activeForm || active.content);
	} else if (done + failed === todos.length) {
		label = failed > 0 ? theme.fg("error", "Finished with failures") : theme.fg("success", "All tasks complete");
	} else {
		label = theme.fg("muted", "No task in progress");
	}

	const countLabel = failed > 0 ? `${done}/${todos.length} (${failed} failed)` : `${done}/${todos.length}`;
	const taskLine = `${bar} ${theme.fg("dim", `${countLabel} · ${progressPercent(todos)}%`)}  ${label}`;

	return [goalLine, taskLine].filter(Boolean).join("\n");
}

/** Serialize the current goal + tasks into the free-text format /edit shows the user. */
function serializeForEdit(goal: string | undefined, todos: Todo[]): string {
	const lines: string[] = [`Goal: ${goal ?? ""}`, ""];
	if (todos.length === 0) {
		lines.push("[ ] ");
	} else {
		for (const todo of todos) {
			const marker = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : todo.status === "failed" ? "!" : " ";
			lines.push(`[${marker}] ${todo.content}`);
		}
	}
	lines.push("", "# [ ] pending   [~] in progress   [x] completed   [!] failed");
	return lines.join("\n");
}

/** Parse text edited via /edit back into a goal + task list. Reuses activeForm from `previous` when content is unchanged. */
function parseEditedText(text: string, previous: Todo[]): TodoState {
	const existingByContent = new Map(previous.map((t) => [t.content.trim().toLowerCase(), t]));
	let goal: string | undefined;
	const parsedTodos: Todo[] = [];
	let isFirstContentLine = true;

	for (const rawLine of text.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (isFirstContentLine) {
			isFirstContentLine = false;
			const goalMatch = trimmed.match(/^goal:\s*(.*)$/i);
			if (goalMatch) {
				goal = goalMatch[1]?.trim() || undefined;
				continue;
			}
		}

		const boxMatch = trimmed.match(/^\[(.?)\]\s*(.*)$/);
		let status: TodoStatus = "pending";
		let content = trimmed;
		if (boxMatch) {
			const marker = (boxMatch[1] ?? "").trim().toLowerCase();
			content = (boxMatch[2] ?? "").trim();
			if (marker === "x") status = "completed";
			else if (marker === "~" || marker === "-") status = "in_progress";
			else if (marker === "!") status = "failed";
			else status = "pending";
		}
		if (!content) continue;

		const existing = existingByContent.get(content.trim().toLowerCase());
		parsedTodos.push({ content, activeForm: existing?.activeForm || content, status });
	}

	return { goal, todos: parsedTodos };
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let goal: string | undefined;

	function loadFromBranch(ctx: ExtensionContext) {
		todos = [];
		goal = undefined;
		let foundState = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
				const data = entry.data as TodoState | undefined;
				todos = data?.todos ?? [];
				goal = data?.goal;
				foundState = true;
				continue;
			}
			// Legacy fallback for sessions written before state entries existed:
			// only trusted until we've seen a real state entry take over.
			if (
				!foundState &&
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === TOOL_NAME
			) {
				todos = (entry.message.details as { todos?: Todo[] } | undefined)?.todos ?? [];
			}
		}
	}

	function syncWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (todos.length === 0 && !goal) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_ID, (_tui: unknown, theme: Theme) => new Text(renderWidgetLine(todos, theme, goal), 0, 0));
	}

	/** Persist current state to the session and refresh the widget. Call after every mutation. */
	function persist(ctx: ExtensionContext) {
		pi.appendEntry<TodoState>(STATE_ENTRY_TYPE, { todos, goal });
		syncWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		loadFromBranch(ctx);
		syncWidget(ctx);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Tasks",
		description:
			"Create the working task list for this session, replacing any previous list. Always pass the FULL list — " +
			"it does not append. Use it once up front to plan multi-step work. For later status changes use " +
			"todo_edit (any status) or todo_done (mark completed), not this tool.",
		promptSnippet: "Plan and track multi-step work as a checklist (pending/in_progress/completed/failed)",
		promptGuidelines: [
			"Call todo_write with a full task breakdown before starting work that has three or more distinct steps, or whenever the user gives several requests at once.",
			"After the initial todo_write, change progress only via todo_edit (set any status) or todo_done (mark completed) — not by resending the whole list.",
			"Keep at most one task marked in_progress at a time; finish it (or explicitly deprioritize it) before starting the next.",
			"Mark a task failed via todo_edit (instead of leaving it in_progress or dropping it silently) when you cannot complete it, and briefly explain why in your next message.",
			"Set or update `goal` when the overall objective changes or is first established; omit it to leave the current goal unchanged.",
			"The user may also edit the list directly via /edit, /task <n> <status>, or /goal. If you notice tasks or the goal changed without you updating them, treat that as the current source of truth.",
			"Skip todo_write for a single trivial action that has no real sub-steps.",
		],
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({
						minLength: 1,
						description: "Imperative task description, e.g. 'Fix auth token refresh bug'",
					}),
					activeForm: Type.String({
						minLength: 1,
						description: "Present-continuous form shown while the task is active, e.g. 'Fixing auth token refresh bug'",
					}),
					status: StringEnum(["pending", "in_progress", "completed", "failed"] as const),
				}),
			),
			goal: Type.Optional(
				Type.String({
					description:
						"Optional: set or update the overarching goal for this session's task list. Omit to leave the current goal unchanged.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			todos = params.todos;
			if (typeof params.goal === "string") goal = params.goal.trim() || undefined;

			const done = todos.filter((t) => t.status === "completed").length;
			const failed = todos.filter((t) => t.status === "failed").length;

			pi.appendEntry<TodoState>(STATE_ENTRY_TYPE, { todos, goal });
			if (ctx) syncWidget(ctx);

			let text = `Task list updated: ${done}/${todos.length} completed${failed ? `, ${failed} failed` : ""}.`;
			const inProgress = todos.filter((t) => t.status === "in_progress");
			if (inProgress.length > 1) {
				text += ` Warning: ${inProgress.length} tasks are in_progress at once (${inProgress.map((t) => `"${t.content}"`).join(", ")}). Keep at most one in_progress.`;
			}

			return {
				content: [{ type: "text", text }],
				details: { todos, goal },
			};
		},
		renderCall(args: { todos?: unknown }, theme: Theme) {
			const count = Array.isArray(args?.todos) ? args.todos.length : 0;
			const text = theme.fg("toolTitle", theme.bold("todo_write ")) + theme.fg("muted", `${count} task${count === 1 ? "" : "s"}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: { details?: { todos?: Todo[]; goal?: string } }, options: { isPartial?: boolean; expanded?: boolean }, theme: Theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Updating tasks..."), 0, 0);
			}

			const list = result.details?.todos ?? [];
			const resultGoal = result.details?.goal;
			if (options.expanded) {
				return new Text(renderChecklist(list, theme, resultGoal), 0, 0);
			}

			const summary = renderWidgetLine(list, theme, resultGoal) || theme.fg("dim", "No tasks yet.");
			const hint = list.length > 0 ? `  ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
			return new Text(summary + hint, 0, 0);
		},
	});

	/** Shared mutation core for todo_edit / todo_done. */
	function applyStatus(index: number, status: TodoStatus): string {
		if (index < 0 || index >= todos.length) {
			return `Error: no task #${index + 1}. There ${todos.length === 1 ? "is" : "are"} ${todos.length} task${todos.length === 1 ? "" : "s"}.`;
		}
		const target = todos[index];
		let next = todos.map((t, i) => (i === index ? { ...t, status } : t));
		if (status === "in_progress") {
			next = next.map((t) => (t.status === "in_progress" && t !== next[index] ? { ...t, status: "pending" as TodoStatus } : t));
		}
		todos = next;
		const done = todos.filter((t) => t.status === "completed").length;
		const failed = todos.filter((t) => t.status === "failed").length;
		pi.appendEntry<TodoState>(STATE_ENTRY_TYPE, { todos, goal });
		return `Task ${index + 1} (${target.content}) marked ${status}. Progress: ${done}/${todos.length} completed${failed ? `, ${failed} failed` : ""}.`;
	}

	function statusToolResult(text: string) {
		return {
			content: [{ type: "text" as const, text }],
			details: { todos, goal },
		};
	}

	pi.registerTool({
		name: EDIT_TOOL_NAME,
		label: "Tasks",
		description:
			"Change the status of an existing task in the working task list. Use this after todo_write has created " +
			"the list — pass the 1-indexed task number and the new status. Do NOT use this to create tasks; use todo_write for that.",
		promptSnippet: "Change the status of an existing task (pending/in_progress/completed/failed) by task number",
		promptGuidelines: [
			"Use todo_edit whenever a task's status changes; do not resend the whole list via todo_write just to flip one status.",
			"Keep at most one task in_progress at a time — marking another in_progress demotes the previous one to pending.",
		],
		parameters: Type.Object({
			task: Type.Number({ minimum: 1, description: "1-indexed number of the task to update (as shown in the checklist)" }),
			status: StringEnum(["pending", "in_progress", "completed", "failed"] as const),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = applyStatus(params.task - 1, params.status);
			if (ctx) syncWidget(ctx);
			return statusToolResult(text);
		},
		renderCall(args: { task?: unknown; status?: unknown }, theme: Theme) {
			const text = theme.fg("toolTitle", theme.bold("todo_edit ")) + theme.fg("muted", `#${args?.task ?? "?"} → ${args?.status ?? "?"}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: { details?: { todos?: Todo[]; goal?: string } }, options: { isPartial?: boolean; expanded?: boolean }, theme: Theme) {
			if (options.isPartial) return new Text(theme.fg("warning", "Updating tasks..."), 0, 0);
			const list = result.details?.todos ?? [];
			const summary = renderWidgetLine(list, theme, result.details?.goal) || theme.fg("dim", "No tasks yet.");
			const hint = list.length > 0 ? `  ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
			return new Text(summary + hint, 0, 0);
		},
	});

	pi.registerTool({
		name: DONE_TOOL_NAME,
		label: "Tasks",
		description:
			"Mark an existing task as completed when its work is finished. Shorthand for todo_edit with status 'completed'. " +
			"Pass the 1-indexed task number. Call immediately after finishing a task rather than batching.",
		promptSnippet: "Mark an existing task as completed by task number",
		promptGuidelines: [
			"Call todo_done immediately after finishing a task, before starting the next one.",
			"If a task cannot be completed, use todo_edit with status 'failed' instead and explain why in your next message.",
		],
		parameters: Type.Object({
			task: Type.Number({ minimum: 1, description: "1-indexed number of the finished task (as shown in the checklist)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = applyStatus(params.task - 1, "completed");
			if (ctx) syncWidget(ctx);
			return statusToolResult(text);
		},
		renderCall(args: { task?: unknown }, theme: Theme) {
			const text = theme.fg("toolTitle", theme.bold("todo_done ")) + theme.fg("success", `#${args?.task ?? "?"}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: { details?: { todos?: Todo[]; goal?: string } }, options: { isPartial?: boolean; expanded?: boolean }, theme: Theme) {
			if (options.isPartial) return new Text(theme.fg("warning", "Updating tasks..."), 0, 0);
			const list = result.details?.todos ?? [];
			const summary = renderWidgetLine(list, theme, result.details?.goal) || theme.fg("dim", "No tasks yet.");
			const hint = list.length > 0 ? `  ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
			return new Text(summary + hint, 0, 0);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show the current task list and goal",
		handler: async () => {
			pi.appendEntry<TodoState>(ENTRY_TYPE, { todos, goal });
		},
	});

	pi.registerCommand(EDIT_COMMAND_NAME, {
		description: "Edit the goal and task list as free text",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const prefill = serializeForEdit(goal, todos);
			const edited = await ctx.ui.editor("Edit tasks", prefill);
			if (edited === undefined) return; // cancelled

			const parsed = parseEditedText(edited, todos);
			goal = parsed.goal;
			todos = parsed.todos;
			persist(ctx);
			ctx.ui.notify(`Saved ${todos.length} task${todos.length === 1 ? "" : "s"}.`, "info");
		},
	});

	pi.registerCommand(TASK_COMMAND_NAME, {
		description: "Manage tasks: /task <n> <status> | /task add <text> | /task rm <n> | /task clear",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			// Bare /task (or /task list): print the current list into the transcript.
			if (!trimmed || trimmed.toLowerCase() === "list") {
				if (!trimmed) {
					ctx.ui.notify("Usage: /task <n> <status> | /task add <text> | /task rm <n> | /task clear", "info");
				}
				if (todos.length === 0) {
					ctx.ui.notify(goal ? `Goal: ${goal}. No tasks yet.` : "No tasks yet.", "info");
				} else {
					const lines = todos.map((t, i) => `${i + 1}. [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : t.status === "failed" ? "!" : " "}] ${t.content}`);
					ctx.ui.notify(lines.join("\n"), "info");
				}
				return;
			}

			// /task add <text>
			const addMatch = trimmed.match(/^add\s+(.+)$/i);
			if (addMatch) {
				const content = (addMatch[1] as string).trim();
				todos = [...todos, { content, activeForm: content, status: "pending" }];
				persist(ctx);
				ctx.ui.notify(`Added task #${todos.length}: ${content}`, "info");
				return;
			}

			// /task rm <n>
			const rmMatch = trimmed.match(/^(?:rm|remove|del|delete)\s+(\d+)$/i);
			if (rmMatch) {
				const index = Number.parseInt(rmMatch[1] as string, 10) - 1;
				if (index < 0 || index >= todos.length) {
					ctx.ui.notify(`No task #${index + 1}.`, "error");
					return;
				}
				const removed = todos[index];
				todos = todos.filter((_, i) => i !== index);
				persist(ctx);
				ctx.ui.notify(`Removed task #${index + 1}: ${(removed as Todo).content}`, "info");
				return;
			}

			// /task clear
			if (/^(clear|reset)$/i.test(trimmed)) {
				const n = todos.length;
				todos = [];
				persist(ctx);
				ctx.ui.notify(`Cleared ${n} task${n === 1 ? "" : "s"}.`, "info");
				return;
			}

		const match = trimmed.match(/^(\d+)\s+(.+)$/);
		if (!match) {
			ctx.ui.notify('Usage: /task <number> <status> | /task add <text> | /task rm <number> | /task clear', "error");
			return;
		}

		// Allow "move 2 5"-style reorder? Kept out — /edit covers reordering.
		const index = Number.parseInt(match[1] as string, 10) - 1;
			const statusWord = (match[2] as string).trim();
			const status = normalizeStatus(statusWord);
			if (!status) {
				ctx.ui.notify(`Unknown status "${statusWord}". Use pending, in_progress, done/completed, or failed.`, "error");
				return;
			}
			if (index < 0 || index >= todos.length) {
				ctx.ui.notify(`No task #${index + 1}. There ${todos.length === 1 ? "is" : "are"} ${todos.length} task${todos.length === 1 ? "" : "s"}.`, "error");
				return;
			}

			if (status === "in_progress") {
				// Mirror the agent guideline: keep at most one task in progress at a time.
				todos = todos.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" } : t));
			}
			todos = todos.map((t, i) => (i === index ? { ...t, status } : t));

			persist(ctx);
			ctx.ui.notify(`Task ${index + 1} marked ${status}.`, "info");
		},
	});

	pi.registerCommand(GOAL_COMMAND_NAME, {
		description: "Show, set, or clear (/goal clear) the session's overarching goal",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(goal ? `Goal: ${goal}` : "No goal set. Usage: /goal <text> (or /goal clear)", "info");
				return;
			}
			if (trimmed.toLowerCase() === "clear") {
				goal = undefined;
				persist(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}
			goal = trimmed;
			persist(ctx);
			ctx.ui.notify(`Goal set: ${goal}`, "info");
		},
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry: { data?: TodoState }, _options: unknown, theme: Theme) => {
		return new Text(renderChecklist(entry.data?.todos ?? [], theme, entry.data?.goal), 1, 0);
	});
}

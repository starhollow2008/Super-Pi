// memory.ts — Persistent memory for pi, backed by SQLite.
//
// Storage: node:sqlite (DatabaseSync) — built into Node 22.5+/26, no native
// compile step, no npm dependency. Database lives at
// ~/.pi/agent/memory/memory.db with WAL mode for safe concurrent reads.
//
// Flow (enforced by design + AGENTS.md policy):
//   1. The model decides something is worth remembering.
//   2. memory_write FIRST asks the user for permission via ask_user_question
//      (options: "Yes, save it" / "No, skip"). Only on a positive answer does
//      it write — and it writes WHAT THE USER CONFIRMED from the conversation
//      context, not a paraphrase the model invented afterwards.
//   3. memory_search / memory_list let the model recall memories later.
//
// On/off switch: settings.json key "memory.enabled" (default true). When off,
// memory_write refuses immediately and the tools report disabled. Toggle with
// /memory on | off | status (persisted, needs /reload only for the widget).
//
// Commands:
//   /memory              — show status + counts
//   /memory on|off       — enable/disable memory (persisted)
//   /memory list [n]     — print the last n memories into the transcript
//   /memory find <text>  — search memories
//   /memory rm <id>      — delete a memory
//   /memory clear        — delete ALL memories (confirm prompt)
//
// Schema (memories):
//   id INTEGER PK, content TEXT NOT NULL, category TEXT DEFAULT 'general',
//   source TEXT DEFAULT 'agent', created_at TEXT, updated_at TEXT

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Settings (memory.enabled) — merged under the "memory" key of settings.json
// ---------------------------------------------------------------------------

const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
const DB_DIR = join(homedir(), ".pi", "agent", "memory");
const DB_FILE = join(DB_DIR, "memory.db");

interface MemorySettings {
	enabled: boolean;
}

const DEFAULT_SETTINGS: MemorySettings = { enabled: true };

function readJsonSafe(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return {};
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function loadSettings(): MemorySettings {
	const root = readJsonSafe(SETTINGS_FILE);
	const stored = (root.memory as Partial<MemorySettings>) ?? {};
	return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(patch: Partial<MemorySettings>): MemorySettings {
	const root = readJsonSafe(SETTINGS_FILE);
	const current = { ...DEFAULT_SETTINGS, ...((root.memory as Partial<MemorySettings>) ?? {}) };
	const next = { ...current, ...patch };
	root.memory = next;
	mkdirSync(join(SETTINGS_FILE, ".."), { recursive: true });
	writeFileSync(SETTINGS_FILE, JSON.stringify(root, null, 2) + "\n", "utf8");
	return next;
}

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

interface MemoryRow {
	id: number;
	content: string;
	category: string;
	source: string;
	created_at: string;
	updated_at: string;
}

function openDb(): DatabaseSync {
	mkdirSync(DB_DIR, { recursive: true });
	const db = new DatabaseSync(DB_FILE);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA busy_timeout = 3000;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS memories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			category TEXT NOT NULL DEFAULT 'general',
			source TEXT NOT NULL DEFAULT 'agent',
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content, category, content='memories', content_rowid='id'
		);
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, category ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
			INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
		END;
	`);
	return db;
}

function rowToMemory(r: any): MemoryRow {
	return {
		id: Number(r.id),
		content: String(r.content),
		category: String(r.category ?? "general"),
		source: String(r.source ?? "agent"),
		created_at: String(r.created_at ?? ""),
		updated_at: String(r.updated_at ?? ""),
	};
}

class MemoryStore {
	private db: DatabaseSync;

	constructor() {
		this.db = openDb();
	}

	insert(content: string, category: string, source: string): MemoryRow {
		this.db
			.prepare("INSERT INTO memories (content, category, source) VALUES (?, ?, ?)")
			.run(content, category, source);
		const row = this.db.prepare("SELECT * FROM memories ORDER BY id DESC LIMIT 1").get() as any;
		return rowToMemory(row);
	}

	get(id: number): MemoryRow | undefined {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
		return row ? rowToMemory(row) : undefined;
	}

	list(limit = 20, offset = 0): MemoryRow[] {
		const rows = this.db
			.prepare("SELECT * FROM memories ORDER BY id DESC LIMIT ? OFFSET ?")
			.all(limit, offset) as any[];
		return rows.map(rowToMemory);
	}

	count(): number {
		const r = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as any;
		return Number(r?.n ?? 0);
	}

	search(query: string, limit = 10): MemoryRow[] {
		// FTS5 first; fall back to LIKE if the query isn't valid FTS syntax.
		try {
			const rows = this.db
				.prepare(
					`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
					 WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
				)
				.all(query, limit) as any[];
			if (rows.length > 0) return rows.map(rowToMemory);
		} catch {
			/* fall through to LIKE */
		}
		const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
		const rows = this.db
			.prepare("SELECT * FROM memories WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?")
			.all(like, limit) as any[];
		return rows.map(rowToMemory);
	}

	remove(id: number): boolean {
		const r = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		return Number(r.changes) > 0;
	}

	clear(): number {
		const before = this.count();
		this.db.exec("DELETE FROM memories;");
		return before;
	}

	close() {
		try {
			this.db.close();
		} catch {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatMemory(m: MemoryRow, theme: any, withBody = false): string {
	const head = theme.fg("dim", `#${m.id}`) + theme.fg("muted", ` [${m.category}]`) + " ";
	if (!withBody) return head + m.content;
	return `${head}${m.content}\n${theme.fg("dim", `  ${m.created_at} · ${m.source}`)}`;
}

function memoryListText(rows: MemoryRow[], theme: any): string {
	if (rows.length === 0) return "No memories stored.";
	return rows.map((m) => formatMemory(m, theme, true)).join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const MEMORY_TOOL = "memory_write";
const SEARCH_TOOL = "memory_search";
const LIST_TOOL = "memory_list";
const CATEGORIES = ["general", "preference", "fact", "project", "person", "workflow"] as const;

export default function memoryExtension(pi: ExtensionAPI) {
	let settings = loadSettings();
	let store: MemoryStore | null = null;

	function getStore(): MemoryStore {
		if (!store) store = new MemoryStore();
		return store;
	}

	// Lazily resolve the ask_user_question tool handler so the permission
	// prompt goes through the exact same UI path the model uses.
	async function askPermission(ctx: ExtensionContext, summary: string): Promise<"yes" | "no" | "unavailable"> {
		if (!ctx.hasUI) return "unavailable";
		try {
			const g = globalThis as any;
			// ask-user-question.ts stashes a shared UI lock on globalThis; reuse it
			// so our prompt serializes with any other pop-up UI.
			const withLock = g.__piSharedUiLock?.withLock ?? ((fn: () => any) => fn());
			return await withLock(async () => {
				const answer = await ctx.ui.select(
					"Save this memory?",
					["Yes, save it", "No, skip"],
				);
				if (answer === undefined) return "no";
				return answer.startsWith("Yes") ? "yes" : "no";
			});
		} catch {
			return "unavailable";
		}
	}

	pi.on("session_shutdown", async () => {
		store?.close();
		store = null;
	});

	// -- memory_write: ask first, then store what the user confirmed ----------
	pi.registerTool({
		name: MEMORY_TOOL,
		label: "Memory",
		description:
			"Save a durable memory about the user or project to the SQLite memory store. " +
			"PERMISSION REQUIRED: this tool first asks the user to approve the exact content. " +
			"Pass the memory text you intend to store, drawn from the conversation context. " +
			"Only call this when something is genuinely worth remembering long-term (a stated " +
			"preference, a durable fact, a project constraint) — not for transient session state.",
		promptSnippet:
			"Persist a long-term memory to SQLite after explicit user approval (ask-first flow)",
		promptGuidelines: [
			"NEVER store a memory without user approval — memory_write asks for permission automatically; respect a 'No' and do not retry with rephrased content.",
			"Only propose memories for durable information: preferences, facts, constraints, workflows. Never transient task state.",
			"The content you pass is shown to the user verbatim for approval — write it as the final memory text, concise and self-contained.",
			"Pick the closest category: preference, fact, project, person, workflow, or general.",
			"After approval, confirm what was stored and its id in your reply.",
		],
		parameters: Type.Object({
			content: Type.String({
				minLength: 1,
				description:
					"The exact memory text to store (shown verbatim to the user for approval). Self-contained, e.g. 'Prefers bun over npm for JavaScript projects'.",
			}),
			category: Type.Optional(
				StringEnum([...CATEGORIES] as unknown as [string, ...string[]], {
					description: "Memory category (default: general).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!settings.enabled) {
				return {
					content: [{ type: "text", text: "Memory is currently disabled (/memory on to re-enable). Nothing was stored." }],
					details: { stored: false, reason: "disabled" },
				};
			}

			const content = params.content.trim();
			if (!content) {
				return {
					content: [{ type: "text", text: "Empty memory content — nothing stored." }],
					details: { stored: false, reason: "empty" },
				};
			}

			const category = params.category?.trim() || "general";
			const permission = await askPermission(ctx, content);

			if (permission === "no") {
				return {
					content: [{ type: "text", text: "User declined. Memory NOT stored." }],
					details: { stored: false, reason: "declined" },
				};
			}
			if (permission === "unavailable") {
				return {
					content: [{ type: "text", text: "Could not ask for permission (no interactive UI). Memory NOT stored — ask the user in chat instead." }],
					details: { stored: false, reason: "no-ui" },
				};
			}

			const row = getStore().insert(content, category, "agent");
			return {
				content: [{ type: "text", text: `User approved. Memory #${row.id} stored (${category}).` }],
				details: { stored: true, id: row.id, category, content: row.content },
			};
		},
		renderCall(args: { content?: unknown; category?: unknown }, theme: any) {
			const text =
				theme.fg("toolTitle", theme.bold("memory_write ")) +
				theme.fg("muted", `[${String(args?.category ?? "general")}] `) +
				theme.fg("dim", "asking permission…");
			return new Text(text, 0, 0);
		},
		renderResult(result: { details?: { stored?: boolean; id?: number; reason?: string; content?: string } }, options: { isPartial?: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "Asking permission…"), 0, 0);
			const d = result.details;
			if (d?.stored) {
				return new Text(theme.fg("success", `✓ Memory #${d.id} stored`), 0, 0);
			}
			const reason = d?.reason === "declined" ? "declined by user" : d?.reason === "disabled" ? "memory disabled" : d?.reason ?? "not stored";
			return new Text(theme.fg("warning", `✗ Not stored (${reason})`), 0, 0);
		},
	});

	// -- memory_search: recall ------------------------------------------------
	pi.registerTool({
		name: SEARCH_TOOL,
		label: "Memory",
		description:
			"Search stored long-term memories (FTS5 full-text with LIKE fallback). Use at the " +
			"start of a session when prior context about the user or project would help, or " +
			"whenever you suspect a relevant memory exists.",
		promptSnippet: "Search previously approved long-term memories (SQLite FTS5)",
		promptGuidelines: [
			"Search memories before asking the user to repeat a known preference or fact.",
			"Use focused keyword queries; results are ranked by relevance.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Search keywords, e.g. 'editor preference' or 'deploy workflow'." }),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Max results (default 10)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!settings.enabled) {
				return { content: [{ type: "text", text: "Memory is disabled." }], details: { results: [] } };
			}
			const rows = getStore().search(params.query, params.limit ?? 10);
			if (rows.length === 0) {
				return { content: [{ type: "text", text: `No memories match "${params.query}".` }], details: { results: [] } };
			}
			const text = rows.map((m) => `#${m.id} [${m.category}] ${m.content}`).join("\n");
			return {
				content: [{ type: "text", text: `Found ${rows.length} memor${rows.length === 1 ? "y" : "ies"}:\n${text}` }],
				details: { results: rows },
			};
		},
		renderCall(args: { query?: unknown }, theme: any) {
			return new Text(theme.fg("toolTitle", theme.bold("memory_search ")) + theme.fg("muted", String(args?.query ?? "")), 0, 0);
		},
		renderResult(result: { details?: { results?: MemoryRow[] } }, options: { isPartial?: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "Searching memories…"), 0, 0);
			const rows = result.details?.results ?? [];
			if (rows.length === 0) return new Text(theme.fg("dim", "No matches"), 0, 0);
			return new Text(theme.fg("success", `✓ ${rows.length} match${rows.length === 1 ? "" : "es"}`) + "\n" + memoryListText(rows, theme), 0, 0);
		},
	});

	// -- memory_list: recent memories ----------------------------------------
	pi.registerTool({
		name: LIST_TOOL,
		label: "Memory",
		description:
			"List the most recent stored memories (newest first). Use to review what is " +
			"already remembered before proposing a new memory, or to recall recent context.",
		promptSnippet: "List recent long-term memories (newest first)",
		promptGuidelines: [
			"Check memory_list before calling memory_write to avoid storing duplicates.",
		],
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "How many to show (default 20)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!settings.enabled) {
				return { content: [{ type: "text", text: "Memory is disabled." }], details: { results: [] } };
			}
			const rows = getStore().list(params.limit ?? 20);
			const total = getStore().count();
			const text = rows.length === 0 ? "Memory store is empty." : `Showing ${rows.length} of ${total} memories:\n${rows.map((m) => `#${m.id} [${m.category}] ${m.content}`).join("\n")}`;
			return { content: [{ type: "text", text }], details: { results: rows, total } };
		},
		renderCall(_args: unknown, theme: any) {
			return new Text(theme.fg("toolTitle", theme.bold("memory_list")), 0, 0);
		},
		renderResult(result: { details?: { results?: MemoryRow[]; total?: number } }, options: { isPartial?: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "Loading memories…"), 0, 0);
			const rows = result.details?.results ?? [];
			if (rows.length === 0) return new Text(theme.fg("dim", "Memory store is empty"), 0, 0);
			return new Text(theme.fg("success", `✓ ${rows.length} memor${rows.length === 1 ? "y" : "ies"}`) + "\n" + memoryListText(rows, theme), 0, 0);
		},
	});

	// -- /memory command -------------------------------------------------------
	pi.registerCommand("memory", {
		description: "Memory: /memory | on | off | list [n] | find <text> | rm <id> | clear",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const theme = (ctx as any).ui?.theme ?? { fg: (_t: string, s: string) => s };

			switch (sub ?? "status") {
				case "status": {
					const n = settings.enabled ? getStore().count() : 0;
					ctx.ui.notify(
						`Memory: ${settings.enabled ? "ON" : "OFF"} · ${n} memor${n === 1 ? "y" : "ies"} stored · ${DB_FILE}`,
						"info",
					);
					return;
				}
				case "on": {
					settings = saveSettings({ enabled: true });
					ctx.ui.notify("Memory enabled.", "info");
					return;
				}
				case "off": {
					settings = saveSettings({ enabled: false });
					ctx.ui.notify("Memory disabled. Existing memories are kept but tools refuse to read/write.", "info");
					return;
				}
				case "list": {
					if (!settings.enabled) {
						ctx.ui.notify("Memory is disabled.", "warning");
						return;
					}
					const n = Number.parseInt(arg, 10);
					const rows = getStore().list(Number.isFinite(n) && n > 0 ? n : 20);
					ctx.ui.notify(memoryListText(rows, theme), "info");
					return;
				}
				case "find": {
					if (!settings.enabled) {
						ctx.ui.notify("Memory is disabled.", "warning");
						return;
					}
					if (!arg) {
						ctx.ui.notify("Usage: /memory find <text>", "info");
						return;
					}
					ctx.ui.notify(memoryListText(getStore().search(arg, 10), theme), "info");
					return;
				}
				case "rm": {
					const id = Number.parseInt(arg, 10);
					if (!Number.isFinite(id)) {
						ctx.ui.notify("Usage: /memory rm <id>", "error");
						return;
					}
					ctx.ui.notify(getStore().remove(id) ? `Deleted memory #${id}.` : `No memory #${id}.`, "info");
					return;
				}
				case "clear": {
					const ok = await ctx.ui.confirm("Clear ALL memories?", `${getStore().count()} memories will be permanently deleted.`);
					if (!ok) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}
					const n = getStore().clear();
					ctx.ui.notify(`Deleted ${n} memor${n === 1 ? "y" : "ies"}.`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Try: on | off | list [n] | find <text> | rm <id> | clear`, "error");
			}
		},
	});
}

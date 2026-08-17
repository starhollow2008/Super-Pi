# pi-toolkit

A bundle of pi extensions + a skill + the `osu-pink` theme, loaded as a
single package. No npm dependencies — nothing to `npm install`.

## Install

Drop this whole folder into one of pi's extension directories, keeping the
name `pi-toolkit` (or anything else — the folder name doesn't matter, only
that `package.json` is directly inside it):

```
~/.pi/agent/extensions/pi-toolkit/     # all projects
.pi/extensions/pi-toolkit/             # this project only
```

pi discovers `package.json`'s `"pi.extensions"` field automatically (one
directory level deep) — no other config needed. Run `/reload` in an open pi
session to pick it up without restarting.

## What's in it

### `todo_write` tool + task commands (`extensions/todo.ts`)

The model's task-planning checklist, extended with:

- **`failed` status** — a fourth state alongside pending/in_progress/completed,
  shown in red with a `✗`, so a task the model couldn't finish is visibly
  distinct from one it just hasn't started.
- **`goal`** — an optional one-line objective for the session, settable by
  the model (via `todo_write`) or you (via `/goal`), shown above the task bar.
- **`/edit`** — opens a free-text editor pre-filled with the current goal and
  checklist (`[ ]`/`[~]`/`[x]`/`[!]`). Edit freely — add, remove, reorder,
  reword, re-status — and save.
- **`/task <n> <status>`** — set one task's status without retyping the whole
  list, e.g. `/task 3 done` or `/task 1 failed`. Status words: `pending`,
  `in_progress`, `done`/`completed`, `failed`.
- **`/goal [text]`** — show the current goal, set a new one, or `/goal clear`.
- **`/tasks`** — unchanged: prints the current checklist + goal into the
  transcript.

State (goal + tasks) is written to a dedicated session entry on every change
— from the model's tool calls *and* from these commands — so it survives
`/reload`, resuming, and forking, and always reflects whichever source
touched it last.

### `ask_user` tool (`extensions/ask.ts`)

Lets the model pause and ask you a short question — multiple-choice
(tappable), yes/no, or free text — and read your answer back in the same
turn, instead of guessing. Its own guidelines tell it to prefer a stated
assumption over asking unless the ambiguity is likely to send it down the
wrong path.

### Fuzzy `edit` matching (`extensions/smart-edit.ts`)

The built-in `edit` tool still requires `oldText` to match a file exactly.
This watches every edit call before it runs: if `oldText` isn't found
verbatim, it searches the target file for the closest matching block (a
line-windowed similarity score) and rewrites `oldText` to that exact text,
so the edit goes through instead of failing on whitespace drift, a stale
line, or a small transcription slip. If nothing close enough exists, it
leaves the call alone and you get the normal "not found" error. A note is
appended to the result whenever a correction was made, so it's never silent.

### File changelog (`extensions/changelog.ts`)

Independent of pi's own `/changelog` (that one's pi's release notes).
Silently logs every `edit`/`write` this session with a timestamp and diff.
View it with:

```
/filelog            last 20 changes, newest first
/filelog all         everything this session
/filelog 5           last 5 changes
/filelog auth.ts     only changes to paths containing "auth.ts"
```

Expand an entry in the transcript to see its diff.

### Wiki skill (`skills/wiki/SKILL.md`)

Teaches the model to keep a `WIKI.md` in the project with one dated entry
per non-trivial change, each with **Change** / **Cause** / **Explanation**
sections — the reasoning behind a change, not another copy of the diff.
Triggers after finishing todo-list work, or when asked to document/explain
a change.

### `osu-pink` theme (`themes/osu-pink.json`)

Registered automatically; pick it via `/settings` → theme, or `/reload` then
select it if it doesn't show up immediately.

## Not in this pass

A few things from the original wishlist are core TUI / core-tool changes
rather than drop-in extensions, so they're left for a separate, more
surgical pass against `packages/tui` and `packages/coding-agent` directly:

- **Click-to-move-cursor** in the input editor — mouse events are already
  parsed, but they're consumed at the alt-screen layer for scrollbar/selection
  before reaching the editor, and there's no public API exposing the editor's
  on-screen position to map a click to a text offset.
- **Ctrl+C/V on Linux** — already fairly thorough in this codebase (Wayland,
  X11, OSC 52 remote fallback; `ctrl+x` copies, `ctrl+v` pastes). Worth
  checking what's actually broken for you before "fixing" it.
- **Visual TUI decorations** beyond widgets/headers/footers/markdown
  transforms (all of which *are* available to extensions and fair game for a
  follow-up `decorations.ts`).
- **Self-editing pi's own config from within pi** — turns out the built-in
  `read`/`edit`/`write` tools already reach `AGENTS.md` and
  `~/.pi/agent/extensions/*.ts` (no cwd sandbox), and `/reload` already
  exists — so this is mostly a discoverability + guardrail layer, not new
  plumbing.

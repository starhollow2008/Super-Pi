---
name: wiki
description: Use after finishing a non-trivial change (bug fix, feature, refactor, migration) to record what changed, why, and how the fix works, as a short dated entry in the project's wiki. Trigger after completing work from a todo list, when the user asks to "document this", "write it up", "explain what you changed", or before ending a session that touched several files.
---

# Wiki: documenting changes

Keep a running, human-readable record of *why* the codebase looks the way it
does — not another copy of the diff (the changelog extension already has
that), but the reasoning a future reader won't get from `git blame` alone.

## Where entries live

`WIKI.md` at the project root. If it doesn't exist, create it with a single
`# Wiki` heading before adding the first entry. If it grows large (a rough
guide: past ~150 entries or clearly unwieldy to scan), split older entries
into `wiki/YYYY-MM.md` files and leave a one-line pointer for each month at
the top of `WIKI.md` — but don't do this preemptively.

## Entry format

One entry per change, newest at the top, using exactly this shape:

```markdown
## <short, specific title> — YYYY-MM-DD

**Change:** What actually changed, in one or two sentences. Name the files
or components involved, not just the topic.

**Cause:** What made this necessary — the bug, the request, the constraint,
the thing that broke. If it traces back to a specific report or decision,
say so.

**Explanation:** How the fix or feature works, and why this approach over
the alternatives if that's not obvious. Enough for someone with no context
to understand the reasoning, not just the mechanics.
```

Keep each section to a few sentences. This is a reasoning log, not a design
doc — if the change genuinely needs a design doc, write one and link it from
here instead of inlining it.

## When to write an entry

- After completing a todo list (or a chunk of one) that involved a real
  decision or a non-obvious fix.
- When the user asks you to document, write up, or explain a change.
- Before compacting or ending a session that made changes worth remembering.

Skip it for mechanical changes with no real "why" (formatting, dependency
bumps, typo fixes) — an entry that just restates the diff isn't worth the
read.

## Writing style

- Title the entry after the change itself ("Fix stale cache on session
  resume"), not after the ticket or the tool call.
- Write Cause and Explanation as if answering "why is this like this?" a
  year from now, when the original conversation is long gone.
- If a change reverses or updates an earlier entry, say so explicitly
  ("Supersedes the 2026-03-01 entry on cache invalidation — that approach
  missed the fork case.") rather than leaving two contradictory entries.
- Don't restate the full diff — that's what /filelog and `git log` are for.

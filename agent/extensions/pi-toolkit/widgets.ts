/**
 * Custom widgets for pi:
 * - Status line in footer (turn counter)
 * - Widget above editor (session info)
 * - Custom footer with tokens/cost left, model + git branch right
 * - /footer toggles between custom and default footer
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let turnCount = 0;
	let sessionStart = Date.now();
	let footerEnabled = true;
	let footerInstalled = false;

	const fmtTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

	function tokenStats(ctx: any) {
		let input = 0,
			output = 0,
			cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				if (m.usage) {
					input += m.usage.input || 0;
					output += m.usage.output || 0;
					cost += m.usage.cost?.total || 0;
				}
			}
		}
		return { input, output, cost };
	}

	function infoLine(ctx: any) {
		const mins = Math.floor((Date.now() - sessionStart) / 60000);
		return ctx.ui.theme.fg("muted", `⏱ ${mins}min · turns: ${turnCount} · /footer toggles footer`);
	}

	function installFooter(ctx: any) {
		footerInstalled = true;
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
				// ctx.sessionManager.getBranch() : session entries — usage tokens
				// via getEntries() (session entries incl. usage), model via ctx.model.
				const { input, output, cost } = tokenStats(ctx);
				const branch = footerData.getGitBranch();
					const left = theme.fg("dim", `↑${fmtTokens(input)} ↓${fmtTokens(output)} $${cost.toFixed(3)}`);
					const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branch ? ` ⎇ ${branch}` : ""}`);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		turnCount = 0;
		sessionStart = Date.now();

		ctx.ui.setStatus("widgets", ctx.ui.theme.fg("dim", "✨ ready"));
		ctx.ui.setWidget("widgets-info", [infoLine(ctx)]);
		if (footerEnabled) installFooter(ctx);
	});

	// session_shutdown : libérer le footer custom pour ne pas laisser un
	// composant attaché à une session terminée (le nouveau footer built-in
	// est réinstallé automatiquement au prochain session_start si besoin).
	pi.on("session_shutdown", async () => {
		footerInstalled = false;
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		turnCount++;
		ctx.ui.setStatus("widgets", ctx.ui.theme.fg("accent", `● turn ${turnCount}…`));
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("widgets", ctx.ui.theme.fg("success", `✓ turn ${turnCount}`));
		ctx.ui.setWidget("widgets-info", [infoLine(ctx)]);
	});

	pi.registerCommand("footer", {
		description: "Toggle custom widgets footer",
		handler: async (_args, ctx) => {
			footerEnabled = !footerEnabled;
			if (footerEnabled) {
				installFooter(ctx);
				ctx.ui.notify("Widgets footer on", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Widgets footer off (default restored)", "info");
			}
		},
	});
}

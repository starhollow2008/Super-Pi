// resources.ts — Registers this package's bundled skills/ and themes/
// directories with pi, so `pi-toolkit` ships its wiki skill and osu-pink
// theme without the user needing to copy them into ~/.pi/agent separately.
//
// This file is only meaningful loaded as part of the pi-toolkit package
// (via package.json's "pi.extensions"); it has no standalone tools/commands.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		return {
			skillPaths: [join(baseDir, "..", "skills")],
			themePaths: [join(baseDir, "..", "themes", "osu-pink.json")],
		};
	});
}

import type { Hub } from "../core/hub";
import { registerBoardView } from "./board";
import { registerBacklogView } from "./backlog";
import { registerTimelineView } from "./timeline";

// Entry point for the custom Bases views: board, backlog tree and timeline.
// Each registers itself through hub.plugin.registerBasesView so everything is
// torn down with the plugin.

export function registerBaseViews(hub: Hub): void {
	registerBoardView(hub);
	registerBacklogView(hub);
	registerTimelineView(hub);
}

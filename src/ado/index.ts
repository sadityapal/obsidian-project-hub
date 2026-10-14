// Project Hub runs fully local: every note, board and chart lives in the vault,
// so there is no Azure DevOps connection in this build. This module keeps the
// module boundary the rest of the plugin expects — the integrator calls
// registerAdo(hub) and assigns the result to hub.sync — while reporting a
// permanently "not connected" state, which the UI already renders as inert.

import type { Hub, SyncApi } from "../core/hub";

/** No-remote implementation of SyncApi: everything reads as offline/disabled. */
export class LocalSync implements SyncApi {
	readonly running = false;
	readonly enabled = false;
	readonly lastSync = 0;
	readonly lastError = "";

	async syncNow(): Promise<void> {}

	onState(): () => void {
		return () => {};
	}

	async syncItem(): Promise<void> {}

	async testConnection(): Promise<string> {
		return "Local vault — Project Hub stores everything in this vault.";
	}

	itemError(): string | null {
		return null;
	}

	hasPendingPush(): boolean {
		return false;
	}
}

/** Registers nothing; hands the plugin its local-only sync facade. */
export function registerAdo(hub: Hub): SyncApi {
	return new LocalSync();
}

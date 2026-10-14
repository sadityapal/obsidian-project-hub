import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import type { Hub } from "../core/hub";

/**
 * A code-block renderer that re-renders whenever the hub store changes.
 * `render` receives an emptied container each time; it may be async.
 */
export class LiveBlock extends MarkdownRenderChild {
	private renderQueued = false;
	private renderCount = 0;

	constructor(
		private hub: Hub,
		containerEl: HTMLElement,
		private renderFn: (el: HTMLElement, block: LiveBlock) => void | Promise<void>,
	) {
		super(containerEl);
	}

	onload(): void {
		this.render();
		this.registerEvent(this.hub.store.on("changed", () => this.queue()));
		this.register(this.hub.sync.onState(() => this.queue()));
	}

	queue(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.requestAnimationFrame(() => {
			this.renderQueued = false;
			this.render();
		});
	}

	render(): void {
		const n = ++this.renderCount;
		const el = this.containerEl;
		try {
			// Render into a detached node first so the swap is atomic and does not flicker.
			const next = createDiv();
			const out = this.renderFn(next, this);
			const swap = () => {
				if (n !== this.renderCount) return;
				el.empty();
				while (next.firstChild) el.appendChild(next.firstChild);
			};
			if (out instanceof Promise) out.then(swap, (e) => this.fail(e));
			else swap();
		} catch (e) {
			this.fail(e);
		}
	}

	private fail(e: unknown): void {
		console.error("Project Hub:", e);
		this.containerEl.empty();
		this.containerEl.createDiv({ cls: "ph-error", text: `Project Hub: ${e instanceof Error ? e.message : String(e)}` });
	}
}

/** Registers a live code block processor. */
export function registerLiveBlock(
	hub: Hub,
	language: string,
	render: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, block: LiveBlock) => void | Promise<void>,
): void {
	hub.plugin.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
		el.addClass("ph-block", `ph-block-${language}`);
		const child = new LiveBlock(hub, el, (target, block) => render(source, target, ctx, block));
		ctx.addChild(child);
	});
}

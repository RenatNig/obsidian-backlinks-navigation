import { App, MarkdownView, TFile, View } from "obsidian";
import { KeysMapper } from "../types";

/**
 * A path to the focused element that survives a re-render of the pane.
 */
interface FocusAnchor {
	/** Path of the note the pane was showing the backlinks for. */
	sourcePath: string;
	/** Path (or title) of the backlinked file the element belongs to. */
	fileKey: string;
	/** Position of the element among the elements of that very file. */
	offset: number;
}

export class BacklinkKeysMapper implements KeysMapper {
	private static readonly FOCUSED_CLASS = "backlink-nav-backlink-focused";

	// Backlinks are rendered asynchronously, so the very first focus attempt made right after the
	// pane becomes active may still find an empty result list.
	private static readonly FOCUS_RETRY_DELAY_MS = 50;
	private static readonly FOCUS_RETRY_ATTEMPTS = 6;

	private focusRetryTimeoutId: number | null = null;
	private lastFocusAnchor: FocusAnchor | null = null;

	constructor(private app: App) {}

	/**
	 * The pane became the active one: put the marker back where the user left it (or on the first
	 * link) right away, so navigation can start without pressing Down/J first.
	 */
	public onViewFocus(containerEl: HTMLElement | null): void {
		this.cancelPendingFocus();
		this.restoreFocus(containerEl, 0);
	}

	/**
	 * The focus moved to another pane: the marker must not linger, otherwise two panes look focused
	 * at the same time and the next key press would act on a pane the user has already left.
	 */
	public onViewBlur(): void {
		this.cancelPendingFocus();

		document
			.querySelectorAll<HTMLElement>(`.${BacklinkKeysMapper.FOCUSED_CLASS}`)
			.forEach((el) => {
				el.classList.remove(BacklinkKeysMapper.FOCUSED_CLASS);

				if (document.activeElement === el) {
					el.blur();
				}
			});
	}

	public dispose(): void {
		this.onViewBlur();
		this.lastFocusAnchor = null;
	}

	private cancelPendingFocus(): void {
		if (this.focusRetryTimeoutId != null) {
			window.clearTimeout(this.focusRetryTimeoutId);
			this.focusRetryTimeoutId = null;
		}
	}

	private restoreFocus(containerEl: HTMLElement | null, attempt: number): void {
		this.focusRetryTimeoutId = null;

		if (this.tryRestoreFocus(containerEl)) {
			return;
		}

		// The pane may legitimately have no backlinks at all, so the retries are bounded.
		if (attempt >= BacklinkKeysMapper.FOCUS_RETRY_ATTEMPTS) {
			return;
		}

		this.focusRetryTimeoutId = window.setTimeout(() => {
			this.restoreFocus(containerEl, attempt + 1);
		}, BacklinkKeysMapper.FOCUS_RETRY_DELAY_MS);
	}

	private tryRestoreFocus(containerEl: HTMLElement | null): boolean {
		const backlinksContainerEl = containerEl ?? this.getBacklinksContainerEl();
		if (backlinksContainerEl == null) {
			return false;
		}

		const items = this.getNavigableElements(backlinksContainerEl);
		const firstEl = items[0];
		if (firstEl == null) {
			return false;
		}

		// Something inside the pane is already focused — keep it instead of jumping around.
		if (this.getCurrentIndex(backlinksContainerEl, items) != null) {
			return true;
		}

		this.focusElement(backlinksContainerEl, this.findAnchoredElement(items) ?? firstEl, items);
		return true;
	}

	/**
	 * The position is remembered as a path to the element — the backlinked file plus the offset
	 * inside its matches — and not as a plain index: the pane re-renders on every vault change,
	 * so a bare index would drift onto an unrelated link.
	 */
	private rememberFocus(items: HTMLElement[], el: HTMLElement): void {
		const index = items.indexOf(el);

		for (let titleIndex = index; titleIndex >= 0; titleIndex--) {
			const fileKey = this.getFileKey(items[titleIndex]);
			if (fileKey == null) {
				continue;
			}

			this.lastFocusAnchor = {
				sourcePath: this.getSourcePath(),
				fileKey,
				offset: index - titleIndex,
			};
			return;
		}

		this.lastFocusAnchor = null;
	}

	private findAnchoredElement(items: HTMLElement[]): HTMLElement | null {
		const anchor = this.lastFocusAnchor;

		// The pane follows the active note, so the backlinks of another note start from the top.
		if (anchor == null || anchor.sourcePath !== this.getSourcePath()) {
			return null;
		}

		const titleIndex = items.findIndex((item) => this.getFileKey(item) === anchor.fileKey);
		if (titleIndex === -1) {
			return null;
		}

		// The file may have fewer matches by now (or be collapsed), so the offset is clamped to the
		// last element that still belongs to that very same file.
		const nextTitleOffset = items
			.slice(titleIndex + 1)
			.findIndex((item) => this.getFileKey(item) != null);
		const lastIndex = nextTitleOffset === -1 ? items.length - 1 : titleIndex + nextTitleOffset;

		return items[Math.min(titleIndex + anchor.offset, lastIndex)] ?? null;
	}

	/**
	 * Non-null only for the elements that represent a backlinked file, so they can act as anchors.
	 */
	private getFileKey(el: HTMLElement | undefined): string | null {
		const titleEl =
			el?.closest<HTMLElement>(".search-result-file-title") ??
			el?.querySelector<HTMLElement>(".search-result-file-title");
		if (titleEl == null) {
			return null;
		}

		const fileKey =
			titleEl.getAttribute("data-path") ??
			titleEl.getAttribute("data-href") ??
			titleEl.textContent?.trim();

		return fileKey === "" || fileKey == null ? null : fileKey;
	}

	private getSourcePath(): string {
		return this.app.workspace.getActiveFile()?.path ?? "";
	}

	public async handleKeyPress(event: KeyboardEvent): Promise<void> {
		switch (event.code) {
			case "KeyJ":
			case "ArrowDown": {
				event.preventDefault();
				this.moveFocus(event, 1);
				break;
			}
			case "KeyK":
			case "ArrowUp": {
				event.preventDefault();
				this.moveFocus(event, -1);
				break;
			}
			case "ArrowRight":
			case "KeyL": {
				if (!event.metaKey) {
					this.openFocused(event);
					break;
				}
				await this.openInBackgroundTab();
				break;
			}
			case "Escape": {
				event.preventDefault();
				this.returnFocusToEditor();
				break;
			}
			default:
		}
	}

	/**
	 * Keyboard-only navigation needs a way out of the pane: Escape drops the marker and hands the
	 * focus back to the note in the main area. The remembered position survives, so coming back
	 * continues from the same link.
	 */
	private returnFocusToEditor(): void {
		this.onViewBlur();

		const leaf = this.app.workspace.getMostRecentLeaf();
		if (leaf == null) {
			return;
		}

		this.app.workspace.setActiveLeaf(leaf, { focus: true });

		// Activating the leaf is not always enough for a note: the caret has to be placed explicitly.
		if (leaf.view instanceof MarkdownView) {
			leaf.view.editor.focus();
		}
	}

	private moveFocus(event: KeyboardEvent, delta: -1 | 1): void {
		const containerEl = this.getBacklinksContainerEl(event);
		if (containerEl == null) {
			return;
		}

		const items = this.getNavigableElements(containerEl);
		if (items.length === 0) {
			return;
		}

		const current = this.getCurrentIndex(containerEl, items);
		const next =
			current == null
				? delta > 0
					? 0
					: items.length - 1
				: Math.max(0, Math.min(items.length - 1, current + delta));
		const el = items[next];
		if (el == null) {
			return;
		}
		this.focusElement(containerEl, el, items);
	}

	private openFocused(event: KeyboardEvent): void {
		const el = this.getFocusedElement(event);
		if (el == null) {
			return;
		}

		// Click is the closest to native behavior for both internal and external links.
		this.getClickTarget(el).click();
	}

	public async openInBackgroundTab(): Promise<boolean> {
		const el = this.getFocusedElement();
		if (el == null) {
			return false;
		}

		const clickTarget = this.getClickTarget(el);
		const linkTarget = this.getLinkTarget(clickTarget);
		if (linkTarget == null) {
			return false;
		}

		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const file = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file);
			return true;
		}

		await this.app.workspace.openLinkText(linkTarget, sourcePath, "tab");
		return true;
	}

	private getClickTarget(el: HTMLElement): HTMLElement {
		const selector = [
			"a.internal-link",
			"a.external-link",
			"[role='link']",
			"[data-href]",
			"[data-path]",
			".search-result-file-title",
			".search-result-file-match",
		].join(", ");

		return (
			el.closest<HTMLElement>(selector) ??
			el.querySelector<HTMLElement>(selector) ??
			el.closest<HTMLElement>(".tree-item-self") ??
			el
		);
	}

	private getBacklinksContainerEl(event?: KeyboardEvent): HTMLElement | null {
		const targetEl =
			this.getTargetEl(event?.target ?? null) ?? this.getTargetEl(document.activeElement);
		const leafContent = targetEl?.closest<HTMLElement>(".workspace-leaf-content[data-type]");
		if (leafContent != null) {
			const viewType = leafContent.getAttribute("data-type");
			return this.isBacklinksViewType(viewType) ? leafContent : null;
		}

		const markedEl = document.querySelector(`.${BacklinkKeysMapper.FOCUSED_CLASS}`);
		const markedLeafContent = markedEl?.closest<HTMLElement>(".workspace-leaf-content[data-type]");
		if (markedLeafContent != null) {
			const viewType = markedLeafContent.getAttribute("data-type");
			return this.isBacklinksViewType(viewType) ? markedLeafContent : null;
		}

		const activeView = this.app.workspace.getActiveViewOfType(View);
		if (activeView == null) {
			return null;
		}

		if (!this.isBacklinksViewType(activeView.getViewType())) {
			return null;
		}

		return activeView.containerEl;
	}

	private getTargetEl(target: EventTarget | null): HTMLElement | null {
		if (target instanceof HTMLElement) {
			return target;
		}

		if (target instanceof Node && target.parentElement instanceof HTMLElement) {
			return target.parentElement;
		}

		return null;
	}

	private isBacklinksViewType(viewType: string | null | undefined): boolean {
		return viewType === "backlink" || viewType === "backlinks" || viewType === "backlink-view";
	}

	private getSectionTitle(sectionEl: HTMLElement): string | null {
		const directTitleContainer = Array.from(sectionEl.children).find(
			(child): child is HTMLElement =>
				child instanceof HTMLElement &&
				(child.classList.contains("tree-item-self") || child.classList.contains("tree-item-inner")),
		);
		const titleEl =
			directTitleContainer?.querySelector<HTMLElement>(".tree-item-inner") ?? directTitleContainer;
		const title = titleEl?.textContent?.trim().toLowerCase();

		return title === "" || title == null ? null : title;
	}

	private getTopLevelTreeItems(containerEl: HTMLElement): HTMLElement[] {
		return Array.from(containerEl.querySelectorAll<HTMLElement>(".tree-item")).filter((itemEl) => {
			const parentTreeItem = itemEl.parentElement?.closest(".tree-item");
			return parentTreeItem == null || !containerEl.contains(parentTreeItem);
		});
	}

	private findSectionByTitle(containerEl: HTMLElement, titlePrefix: string): HTMLElement | null {
		const titleEls = Array.from(
			containerEl.querySelectorAll<HTMLElement>(".tree-item-self, .tree-item-inner"),
		);

		for (const titleEl of titleEls) {
			const title = titleEl.textContent?.trim().toLowerCase();
			if (!title?.startsWith(titlePrefix)) {
				continue;
			}

			const sectionEl = titleEl.closest<HTMLElement>(".tree-item");
			if (sectionEl != null) {
				return sectionEl;
			}
		}

		return null;
	}

	private getLinkedMentionsContainerEl(containerEl: HTMLElement): HTMLElement | null {
		const backlinkPaneEl = containerEl.querySelector<HTMLElement>(".backlink-pane") ?? containerEl;
		const sections = this.getTopLevelTreeItems(backlinkPaneEl);

		for (const sectionEl of sections) {
			const title = this.getSectionTitle(sectionEl);
			if (title == null) {
				continue;
			}

			if (title.startsWith("linked mentions")) {
				return sectionEl;
			}
		}

		const linkedMentionsSectionEl = this.findSectionByTitle(backlinkPaneEl, "linked mentions");
		if (linkedMentionsSectionEl != null) {
			return linkedMentionsSectionEl;
		}

		return backlinkPaneEl.querySelector<HTMLElement>(".search-result-container");
	}

	private getNavigableElements(containerEl: HTMLElement): HTMLElement[] {
		const linkedMentionsContainerEl = this.getLinkedMentionsContainerEl(containerEl);
		if (linkedMentionsContainerEl == null) {
			return [];
		}

		// Backlinks markup is not part of the public API, so we keep selectors broad and ordered by preference.
		const selector = [
			"a.internal-link",
			"a.external-link",
			"[role='link']",
			".internal-link",
			"[data-href]",
			".search-result-file-title",
			".search-result-file-match",
		].join(", ");

		const all = Array.from(linkedMentionsContainerEl.querySelectorAll(selector));
		const unique = new Set<HTMLElement>();

		for (const node of all) {
			if (!(node instanceof HTMLElement)) {
				continue;
			}

			// Skip hidden elements.
			const rect = node.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				continue;
			}

			unique.add(node);
		}

		return Array.from(unique);
	}

	private clearMarker(containerEl: HTMLElement): void {
		containerEl.querySelectorAll(`.${BacklinkKeysMapper.FOCUSED_CLASS}`).forEach((el) => {
			el.classList.remove(BacklinkKeysMapper.FOCUSED_CLASS);
		});
	}

	private focusElement(containerEl: HTMLElement, el: HTMLElement, items: HTMLElement[]): void {
		this.clearMarker(containerEl);
		el.classList.add(BacklinkKeysMapper.FOCUSED_CLASS);
		this.rememberFocus(items, el);

		// Ensure programmatic focus works even if element isn't tabbable by default.
		if (el.tabIndex < 0) {
			el.tabIndex = -1;
		}

		el.focus({ preventScroll: true });
		el.scrollIntoView({ block: "nearest" });
	}

	private getCurrentIndex(containerEl: HTMLElement, items: HTMLElement[]): number | null {
		const active = document.activeElement;
		if (active instanceof HTMLElement) {
			const idx = items.indexOf(active);
			if (idx !== -1) {
				return idx;
			}
		}

		const marked = containerEl.querySelector(`.${BacklinkKeysMapper.FOCUSED_CLASS}`);
		if (marked instanceof HTMLElement) {
			const idx = items.indexOf(marked);
			if (idx !== -1) {
				return idx;
			}
		}

		return null;
	}

	private getFocusedElement(event?: KeyboardEvent): HTMLElement | null {
		const containerEl = this.getBacklinksContainerEl(event);
		if (containerEl == null) {
			return null;
		}

		const items = this.getNavigableElements(containerEl);
		if (items.length === 0) {
			return null;
		}

		const current = this.getCurrentIndex(containerEl, items);
		const idx = current == null ? 0 : Math.max(0, Math.min(items.length - 1, current));
		return items[idx] ?? null;
	}

	private getLinkTarget(el: HTMLElement): string | null {
		const treeItemEl = el.closest<HTMLElement>(".tree-item");
		const targetEl =
			el.closest<HTMLElement>("[data-href], [data-path], a[href]") ??
			el.querySelector<HTMLElement>("[data-href], [data-path], a[href]") ??
			treeItemEl?.querySelector<HTMLElement>(
				":scope > .tree-item-self [data-href], :scope > .tree-item-self [data-path], :scope > .tree-item-self a[href], :scope > .tree-item-self[data-href], :scope > .tree-item-self[data-path]",
			);
		const linkTarget =
			targetEl?.getAttribute("data-href") ??
			targetEl?.getAttribute("data-path") ??
			targetEl?.getAttribute("href");

		if (linkTarget != null && linkTarget !== "") {
			return linkTarget;
		}

		const fallbackTitle = treeItemEl
			?.querySelector<HTMLElement>(":scope > .tree-item-self .tree-item-inner")
			?.textContent?.trim();

		return fallbackTitle === "" || fallbackTitle == null ? null : fallbackTitle;
	}
}

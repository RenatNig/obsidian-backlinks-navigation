import { App, TFile, View } from "obsidian";
import { KeysMapper } from "../types";

export class BacklinkKeysMapper implements KeysMapper {
	private static readonly FOCUSED_CLASS = "backlink-nav-backlink-focused";

	constructor(private app: App) {}

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
			default:
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
		this.focusElement(containerEl, el);
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

	private focusElement(containerEl: HTMLElement, el: HTMLElement): void {
		this.clearMarker(containerEl);
		el.classList.add(BacklinkKeysMapper.FOCUSED_CLASS);

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

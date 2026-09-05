export interface KeysMapper {
	handleKeyPress(event: KeyboardEvent): Promise<void>;

	/**
	 * Called when the pane owned by this mapper becomes the active one.
	 * `containerEl` is passed when the caller already knows the pane element, otherwise the
	 * mapper resolves it on its own.
	 */
	onViewFocus?(containerEl: HTMLElement | null): void;

	/**
	 * Called when the focus moves to any other pane, so the mapper can drop its focus marker.
	 */
	onViewBlur?(): void;

	/**
	 * Called on plugin unload: cancel pending work and clean up the DOM.
	 */
	dispose?(): void;
}

export enum ViewType {
	Backlink = "backlink",
}

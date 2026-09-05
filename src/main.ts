import { BacklinkKeysMapper } from "./mappers/BacklinkKeysMapper";
import { KeysMapper, ViewType } from "./types";
import { View, Plugin, WorkspaceLeaf } from "obsidian";

export default class BacklinksKeyboardNav extends Plugin {
  private keysMappers: Record<string, KeysMapper> = {} as Record<
    string,
    KeysMapper
  >;
  private backlinkKeysMapper!: BacklinkKeysMapper;

  // Keydown and focus events in some panes may be stopped before reaching the bubbling phase,
  // so we listen in capture phase for reliability.
  private static readonly CAPTURE_PHASE = true;

  public async onload(): Promise<void> {
    this.backlinkKeysMapper = new BacklinkKeysMapper(this.app);
    this.keysMappers = {
      [ViewType.Backlink]: this.backlinkKeysMapper,
    };

    // Always listen for keydown (capture phase). We still route actions only for supported panes,
    // but this avoids relying on focus/leaf-change events that may not fire for some sidebar panes.
    document.addEventListener(
      "keydown",
      this.handleKeyPress,
      BacklinksKeyboardNav.CAPTURE_PHASE,
    );

    // Focus routing needs both signals: `active-leaf-change` covers command/hotkey driven switches
    // that never move the DOM focus, `focusin` covers clicks inside a pane that do not always
    // change the active leaf (sidebar panes in particular).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.handleActiveLeafChange),
    );
    this.registerDomEvent(
      document,
      "focusin",
      this.handleFocusIn,
      BacklinksKeyboardNav.CAPTURE_PHASE,
    );
  }

  public onunload() {
    document.removeEventListener(
      "keydown",
      this.handleKeyPress,
      BacklinksKeyboardNav.CAPTURE_PHASE,
    );

    for (const mappedViewType of Object.keys(this.keysMappers)) {
      this.keysMappers[mappedViewType]?.dispose?.();
    }
  }

  private handleKeyPress = (event: KeyboardEvent): void => {
    Promise.resolve()
      .then(() => {
        const activeViewType = this.getViewTypeFromEvent(event);

        if (
          activeViewType != null &&
          this.keysMappers[activeViewType] != null &&
          this.checkIsShouldHandleKeyPress(event)
        ) {
          event.stopImmediatePropagation();
          return this.keysMappers[activeViewType].handleKeyPress(event);
        }

        return;
      })
      .catch(console.error);
  };

  private handleActiveLeafChange = (leaf: WorkspaceLeaf | null): void => {
    const view = leaf?.view;

    this.syncActiveView(
      this.normalizeViewType(view?.getViewType()),
      view?.containerEl ?? null,
      true,
    );
  };

  private handleFocusIn = (event: FocusEvent): void => {
    const { hasLeafContext, viewType, leafContentEl } =
      this.inferViewTypeFromDomTarget(event.target);

    // Focus went somewhere outside of the panes (ribbon, modal, status bar) — the pane that was
    // active before is still the one the user works with, so the current state is kept.
    if (!hasLeafContext) {
      return;
    }

    this.syncActiveView(
      viewType,
      leafContentEl,
      // Never steal the focus from a text field, e.g. the Backlinks search filter.
      !BacklinksKeyboardNav.checkIsEditableTarget(event.target),
    );
  };

  /**
   * The single entry point for focus routing: the mapper of the newly active pane may take the
   * focus, every other mapper drops its focus marker so that only one pane ever looks focused.
   */
  private syncActiveView(
    viewType: string | null,
    containerEl: HTMLElement | null,
    allowFocusTakeover: boolean,
  ): void {
    for (const mappedViewType of Object.keys(this.keysMappers)) {
      if (mappedViewType !== viewType) {
        this.keysMappers[mappedViewType]?.onViewBlur?.();
      }
    }

    if (viewType == null || !allowFocusTakeover) {
      return;
    }

    this.keysMappers[viewType]?.onViewFocus?.(containerEl);
  }

  private getViewTypeFromEvent(event: KeyboardEvent): string | null {
    const targetView = this.inferViewTypeFromDomTarget(event.target);
    if (targetView.hasLeafContext) {
      return targetView.viewType;
    }

    const activeElementView = this.inferViewTypeFromDomTarget(
      document.activeElement,
    );
    if (activeElementView.hasLeafContext) {
      return activeElementView.viewType;
    }

    return this.normalizeViewType(
      this.app.workspace.getActiveViewOfType(View)?.getViewType(),
    );
  }

  private normalizeViewType(
    viewType: string | null | undefined,
  ): string | null {
    if (viewType == null) {
      return null;
    }

    switch (viewType) {
      case "backlinks":
      case "backlink-view":
        return ViewType.Backlink;
      default:
        return viewType;
    }
  }

  private inferViewTypeFromDomTarget(target: EventTarget | null): {
    hasLeafContext: boolean;
    viewType: string | null;
    leafContentEl: HTMLElement | null;
  } {
    if (!(target instanceof HTMLElement)) {
      return { hasLeafContext: false, viewType: null, leafContentEl: null };
    }

    // Obsidian sets `data-type` on leaf content containers.
    const leafContent = target.closest<HTMLElement>(
      ".workspace-leaf-content[data-type]",
    );
    if (leafContent == null) {
      return { hasLeafContext: false, viewType: null, leafContentEl: null };
    }

    const dataType = leafContent.getAttribute("data-type");
    return {
      hasLeafContext: true,
      viewType: this.normalizeViewType(dataType),
      leafContentEl: leafContent,
    };
  }

  private static checkIsEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return (
      target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT"
    );
  }

  /**
   * NOTE: the order of checks is important as we want to minimize the impact on performance,
   * so the most generic and performant checks should come first.
   */
  private checkIsShouldHandleKeyPress(event: KeyboardEvent): boolean {
    // Ignore synthetic events dispatched by the plugin itself (e.g. Arrow keys for Backlinks/File Explorer),
    // so we don't accidentally re-handle them and interfere with native Obsidian behavior.
    if (!event.isTrusted) {
      return false;
    }

    // Typing in a text field (e.g. the Backlinks search filter) must not trigger navigation.
    if (BacklinksKeyboardNav.checkIsEditableTarget(event.target)) {
      return false;
    }

    const isBackgroundTabOpenAttempt = event.metaKey;

    // Block other unsupported modifier combinations (except the background tab opening one)
    const isUnsupportedKeyStroke =
      !isBackgroundTabOpenAttempt &&
      (event.ctrlKey || event.altKey || event.shiftKey);

    if (isUnsupportedKeyStroke) {
      return false;
    }

    const isSomePopupOpen = Boolean(document.querySelector(".modal"));
    return !isSomePopupOpen;
  }
}

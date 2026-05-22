import { BacklinkKeysMapper } from "./mappers/BacklinkKeysMapper";
import { KeysMapper, ViewType } from "./types";
import { View, Plugin } from "obsidian";

export default class BacklinksKeyboardNav extends Plugin {
  private keysMappers: Record<string, KeysMapper> = {} as Record<
    string,
    KeysMapper
  >;
  private backlinkKeysMapper!: BacklinkKeysMapper;

  // Keydown events in some panes may be stopped before reaching the bubbling phase,
  // so we listen in capture phase for reliability.
  private static readonly KEYDOWN_CAPTURE = true;

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
      BacklinksKeyboardNav.KEYDOWN_CAPTURE,
    );
  }

  public onunload() {
    document.removeEventListener(
      "keydown",
      this.handleKeyPress,
      BacklinksKeyboardNav.KEYDOWN_CAPTURE,
    );
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
  } {
    if (!(target instanceof HTMLElement)) {
      return { hasLeafContext: false, viewType: null };
    }

    // Obsidian sets `data-type` on leaf content containers.
    const leafContent = target.closest<HTMLElement>(
      ".workspace-leaf-content[data-type]",
    );
    if (leafContent == null) {
      return { hasLeafContext: false, viewType: null };
    }

    const dataType = leafContent.getAttribute("data-type");
    return {
      hasLeafContext: true,
      viewType: this.normalizeViewType(dataType),
    };
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

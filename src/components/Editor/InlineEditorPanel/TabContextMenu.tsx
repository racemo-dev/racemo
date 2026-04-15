import { type RefObject } from "react";
import CtxItem from "./CtxItem";
import { type CtxMenuState } from "./helpers";
import { destroyBrowserWebview } from "../BrowserViewer";
import { type PanelTab } from "../../../stores/panelEditorStore";
import { type TranslationKey } from "../../../lib/i18n/git";

interface TabContextMenuProps {
  ctxMenu: CtxMenuState;
  ctxMenuRef: RefObject<HTMLDivElement | null>;
  tabs: PanelTab[];
  closeOthers: (index: number) => void;
  closeToRight: (index: number) => void;
  onCloseTab: (index: number) => void;
  onCloseAll: () => void;
  onDismiss: () => void;
  t: (key: TranslationKey) => string;
}

export default function TabContextMenu({
  ctxMenu,
  ctxMenuRef,
  tabs,
  closeOthers,
  closeToRight,
  onCloseTab,
  onCloseAll,
  onDismiss,
  t,
}: TabContextMenuProps) {
  return (
    <div
      ref={ctxMenuRef}
      style={{
        position: "fixed",
        top: ctxMenu.y,
        left: ctxMenu.x,
        zIndex: 9999,
        background: "var(--bg-overlay)",
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        padding: "4px 0",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        minWidth: 160,
      }}
    >
      <CtxItem label={t("editor.closeTab")} onClick={() => { onCloseTab(ctxMenu.index); onDismiss(); }} />
      <CtxItem label={t("editor.closeOthers")} onClick={() => {
        tabs.forEach((t, i) => { if (i !== ctxMenu.index && t.type === "browser") destroyBrowserWebview(t.path); });
        closeOthers(ctxMenu.index); onDismiss();
      }} />
      <CtxItem label={t("editor.closeRight")} onClick={() => {
        tabs.forEach((t, i) => { if (i > ctxMenu.index && t.type === "browser") destroyBrowserWebview(t.path); });
        closeToRight(ctxMenu.index); onDismiss();
      }} />
      <div style={{ height: 1, background: "var(--border-subtle)", margin: "4px 0" }} />
      <CtxItem danger label={t("editor.closeAll")} onClick={() => { onCloseAll(); onDismiss(); }} />
    </div>
  );
}

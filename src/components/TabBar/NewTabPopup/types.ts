// Layout types: single, 2-horizontal, 2-vertical, 3, 4
export type LayoutOption = "1" | "2h" | "2v" | "3" | "4";

export interface NewTabPopupProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

// Recent folders storage
export const RECENT_FOLDERS_KEY = "racemo:recentFolders";
export const MAX_RECENT_FOLDERS = 5;

export const LAYOUT_OPTIONS: LayoutOption[] = ["1", "2h", "2v", "3", "4"];

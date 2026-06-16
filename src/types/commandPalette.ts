export interface CommandItem {
  id: string;
  label: string;
  category: "internal" | "recent";
  icon?: string;
  action: () => void;
  shortcut?: string;
  keywords?: string;
}

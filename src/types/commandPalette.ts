export interface Snippet {
  id: string;
  name: string;
  command: string;
  category?: string;
  createdAt: number;
}

export interface CommandItem {
  id: string;
  label: string;
  category: "snippet" | "internal" | "recent";
  icon?: string;
  action: () => void;
  shortcut?: string;
  keywords?: string;
}

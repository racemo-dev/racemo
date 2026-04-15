import {
  File,
  FileCode,
  FileJs,
  FileText,
  Terminal,
} from "@phosphor-icons/react";

/** File type icon based on extension. Shared by explorer and git panels. */
export default function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  let Icon = File;
  let color = "var(--text-muted)";

  if (ext === "tsx" || ext === "ts" || ext === "js" || ext === "jsx") {
    Icon = FileCode;
    color = "var(--accent-blue)";
  } else if (ext === "css" || ext === "scss") {
    Icon = FileCode;
    color = "var(--accent-purple)";
  } else if (ext === "rs") {
    Icon = FileCode;
    color = "var(--accent-red)";
  } else if (ext === "json" || ext === "toml" || ext === "yaml" || ext === "yml") {
    Icon = FileJs;
    color = "var(--accent-yellow)";
  } else if (ext === "md") {
    Icon = FileText;
    color = "var(--accent-cyan)";
  } else if (ext === "sh" || ext === "bash" || ext === "zsh") {
    Icon = Terminal;
    color = "var(--status-active)";
  }

  return <Icon size={15} weight="regular" color={color} style={{ width: 'calc(15px * var(--ui-scale))', height: 'calc(15px * var(--ui-scale))', flexShrink: 0, opacity: 0.8 }} />;
}

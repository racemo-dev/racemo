export interface CompletionItem {
  label: string;
  insertText: string;
  kind: "file" | "directory" | "command" | "subcommand" | "option" | "argument" | "history" | "envvar";
  description?: string;
  favorite?: boolean;
}

export interface CompletionSpec {
  name: string;
  subcommands?: Record<string, CompletionSubcommand>;
}

export interface CompletionSubcommand {
  description?: string;
  options?: CompletionOption[];
  subcommands?: Record<string, CompletionSubcommand>;
  args?: CompletionArg;
}

export interface CompletionOption {
  name: string;
  alias?: string;
  description?: string;
  takesArg?: boolean;
}

export interface CompletionArg {
  name: string;
  template?: "filepaths" | "directories" | "history";
}

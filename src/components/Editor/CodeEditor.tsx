import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, RangeSetBuilder } from "@codemirror/state";
import { keymap, tooltips, ViewPlugin, Decoration, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { java as javaLang } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { php } from "@codemirror/lang-php";
import { search, searchKeymap, SearchQuery, setSearchQuery, findNext, findPrevious } from "@codemirror/search";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { python } from "@codemirror/legacy-modes/mode/python";
import { go } from "@codemirror/legacy-modes/mode/go";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { cpp, kotlin, scala, dart, csharp } from "@codemirror/legacy-modes/mode/clike";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { r } from "@codemirror/legacy-modes/mode/r";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { fSharp, oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { crystal } from "@codemirror/legacy-modes/mode/crystal";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { sass } from "@codemirror/lang-sass";
import { vue } from "@codemirror/lang-vue";
import SearchBar, { type SearchBarHandle } from "../SearchBar";

interface CodeEditorProps {
  content: string;
  language: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

function getLangExtension(language: string) {
  switch (language) {
    case "javascript":
    case "typescript":
      return javascript({ typescript: language === "typescript", jsx: true });
    case "json":
      return json();
    case "rust":
      return rust();
    case "css":
      return css();
    case "html":
      return html();
    case "markdown":
      return markdown();
    case "shell":
      return StreamLanguage.define(shell);
    case "yaml":
      return StreamLanguage.define(yaml);
    case "toml":
      return StreamLanguage.define(toml);
    case "python":
      return StreamLanguage.define(python);
    case "go":
      return StreamLanguage.define(go);
    case "dockerfile":
      return StreamLanguage.define(dockerFile);
    case "powershell":
      return StreamLanguage.define(powerShell);
    case "cpp":
      return StreamLanguage.define(cpp);
    case "java":
      return javaLang();
    case "kotlin":
      return StreamLanguage.define(kotlin);
    case "scala":
      return StreamLanguage.define(scala);
    case "dart":
      return StreamLanguage.define(dart);
    case "ruby":
      return StreamLanguage.define(ruby);
    case "swift":
      return StreamLanguage.define(swift);
    case "lua":
      return StreamLanguage.define(lua);
    case "perl":
      return StreamLanguage.define(perl);
    case "r":
      return StreamLanguage.define(r);
    case "groovy":
      return StreamLanguage.define(groovy);
    case "sql":
      return sql();
    case "xml":
      return xml();
    case "php":
      return php();
    case "csharp":
      return StreamLanguage.define(csharp);
    case "vb":
      return StreamLanguage.define(vb);
    case "fsharp":
      return StreamLanguage.define(fSharp);
    case "ocaml":
      return StreamLanguage.define(oCaml);
    case "haskell":
      return StreamLanguage.define(haskell);
    case "erlang":
      return StreamLanguage.define(erlang);
    case "elixir":
      return StreamLanguage.define(erlang); // best available approximation
    case "clojure":
      return StreamLanguage.define(clojure);
    case "julia":
      return StreamLanguage.define(julia);
    case "elm":
      return StreamLanguage.define(elm);
    case "crystal":
      return StreamLanguage.define(crystal);
    case "nginx":
      return StreamLanguage.define(nginx);
    case "protobuf":
      return StreamLanguage.define(protobuf);
    case "coffeescript":
      return StreamLanguage.define(coffeeScript);
    case "sass":
      return sass();
    case "vue":
      return vue();
    case "properties":
      return StreamLanguage.define(properties);
    case "cmake":
      return StreamLanguage.define(cmake);
    case "hcl":
      return StreamLanguage.define(properties); // closest available
    default:
      return [];
  }
}

/* ─── Syntax highlight colors (VS Code–inspired dark theme) ─── */
const syntaxColors = HighlightStyle.define([
  { tag: tags.keyword,                 color: "#c586c0" },
  { tag: tags.controlKeyword,          color: "#c586c0" },
  { tag: tags.operatorKeyword,         color: "#c586c0" },
  { tag: tags.definitionKeyword,       color: "#c586c0" },
  { tag: tags.moduleKeyword,           color: "#c586c0" },
  { tag: tags.operator,                color: "#d4d4d4" },
  { tag: tags.punctuation,             color: "#d4d4d4" },
  { tag: tags.bracket,                 color: "#ffd700" },
  { tag: tags.string,                  color: "#ce9178" },
  { tag: tags.regexp,                  color: "#d16969" },
  { tag: tags.number,                  color: "#b5cea8" },
  { tag: tags.bool,                    color: "#569cd6" },
  { tag: tags.null,                    color: "#569cd6" },
  { tag: tags.variableName,            color: "#9cdcfe" },
  { tag: tags.definition(tags.variableName), color: "#4fc1ff" },
  { tag: tags.function(tags.variableName),   color: "#dcdcaa" },
  { tag: tags.propertyName,            color: "#9cdcfe" },
  { tag: tags.function(tags.propertyName),   color: "#dcdcaa" },
  { tag: tags.definition(tags.propertyName), color: "#4fc1ff" },
  { tag: tags.typeName,                color: "#4ec9b0" },
  { tag: tags.className,               color: "#4ec9b0" },
  { tag: tags.namespace,               color: "#4ec9b0" },
  { tag: tags.macroName,               color: "#dcdcaa" },
  { tag: tags.labelName,               color: "#c8c8c8" },
  { tag: tags.comment,                 color: "#6a9955", fontStyle: "italic" },
  { tag: tags.lineComment,             color: "#6a9955", fontStyle: "italic" },
  { tag: tags.blockComment,            color: "#6a9955", fontStyle: "italic" },
  { tag: tags.docComment,              color: "#608b4e", fontStyle: "italic" },
  { tag: tags.meta,                    color: "#569cd6" },
  { tag: tags.annotation,              color: "#dcdcaa" },
  { tag: tags.tagName,                 color: "#569cd6" },
  { tag: tags.attributeName,           color: "#9cdcfe" },
  { tag: tags.attributeValue,          color: "#ce9178" },
  { tag: tags.heading,                 color: "#569cd6", fontWeight: "bold" },
  { tag: tags.emphasis,                fontStyle: "italic" },
  { tag: tags.strong,                  fontWeight: "bold" },
  { tag: tags.link,                    color: "#569cd6", textDecoration: "underline" },
  { tag: tags.strikethrough,           textDecoration: "line-through" },
  { tag: tags.invalid,                 color: "#f44747" },
  { tag: tags.atom,                    color: "#569cd6" },
  { tag: tags.self,                    color: "#569cd6" },
  { tag: tags.special(tags.string),    color: "#d7ba7d" },
]);

/* ─── Markdown heading line background decorations ─── */
const headingDecos = [1, 2, 3, 4, 5, 6].map((l) =>
  Decoration.line({ class: `cm-md-h${l}` }),
);

const mdHeadingBgPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          const m = line.text.match(/^(#{1,6})\s/);
          if (m) b.add(line.from, line.from, headingDecos[m[1].length - 1]);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export default function CodeEditor({ content, language, onChange, onSave }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const langCompartment = useRef(new Compartment());
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const [searchOpen, setSearchOpen] = useState(false);
  const [cmView, setCmView] = useState<EditorView | null>(null);
  const searchBarRef = useRef<SearchBarHandle>(null);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const theme = EditorView.theme({
      "&": {
        height: "100%",
        fontSize: "var(--fs-13)",
        backgroundColor: "var(--bg-base)",
        color: "var(--text-primary)",
      },
      ".cm-content": {
        caretColor: "var(--text-secondary)",
        fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)",
        lineHeight: "1.6",
      },
      ".cm-gutters": {
        backgroundColor: "var(--bg-surface)",
        color: "var(--text-muted)",
        border: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "3.5em",
        paddingRight: "12px",
      },
      ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.04)" },
      ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-secondary)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "rgba(38,79,120,0.6) !important",
      },
      ".cm-matchingBracket": {
        backgroundColor: "rgba(255,255,255,0.1)",
        outline: "1px solid rgba(255,255,255,0.2)",
      },
      ".cm-cursor": { borderLeftColor: "var(--text-secondary)" },
      ".cm-foldGutter": { color: "var(--text-muted)" },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        color: "var(--text-primary)",
      },
      ".cm-tooltip-autocomplete": {
        backgroundColor: "var(--bg-elevated)",
      },
      ".cm-completionLabel": { color: "var(--text-primary)" },
      ".cm-completionMatchedText": { color: "var(--accent-blue)", textDecoration: "none" },
      /* Hide default CM search panel */
      ".cm-panels": { display: "none" },
      /* ─── Markdown heading line backgrounds ─── */
      ".cm-md-h1": { backgroundColor: "color-mix(in srgb, var(--accent-blue) 14%, transparent)", borderRadius: "3px" },
      ".cm-md-h2": { backgroundColor: "color-mix(in srgb, var(--accent-blue) 10%, transparent)", borderRadius: "3px" },
      ".cm-md-h3": { backgroundColor: "color-mix(in srgb, var(--accent-cyan) 10%, transparent)", borderRadius: "3px" },
      ".cm-md-h4": { backgroundColor: "rgba(220,220,170,0.08)", borderRadius: "3px" },
      ".cm-md-h5": { backgroundColor: "rgba(200,200,200,0.06)", borderRadius: "3px" },
      ".cm-md-h6": { backgroundColor: "rgba(200,200,200,0.04)", borderRadius: "3px" },
    }, { dark: true });

    const setSearchOpenRef = setSearchOpen;
    const searchBarRefLocal = searchBarRef;
    const findKeymap = keymap.of([
      {
        key: "Mod-f",
        run: () => { setSearchOpenRef(true); setTimeout(() => searchBarRefLocal.current?.focus(), 0); return true; },
      },
      ...searchKeymap.filter((k) => k.key !== "Mod-f" && k.key !== "Escape"),
    ]);

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => { onSaveRef.current(); return true; },
      },
    ]);

    const state = EditorState.create({
      doc: content,
      extensions: [
        findKeymap,
        saveKeymap,
        basicSetup,
        theme,
        syntaxHighlighting(syntaxColors),
        search({ createPanel: () => ({ dom: document.createElement("div") }) }),
        tooltips({ parent: document.body }),
        langCompartment.current.of(getLangExtension(language)),
        language === "markdown" ? mdHeadingBgPlugin : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            contentRef.current = newContent;
            onChangeRef.current(newContent);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    setCmView(view);

    return () => {
      view.destroy();
      viewRef.current = null;
      setCmView(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global Ctrl+F: open search bar even when focus is outside the editor
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.code !== "KeyF") return;
      // Skip if focus is inside a terminal pane (terminal has its own handler)
      const target = e.target as HTMLElement;
      if (target.closest("[data-terminal-pane]")) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchBarRef.current?.focus(), 0);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  // Global Ctrl+A: select all text in the editor (even when focus is outside)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.code !== "KeyA") return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-terminal-pane]") || target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const view = viewRef.current;
      if (!view) return;
      e.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  // Update content from external source (tab switch)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content === contentRef.current) return;
    contentRef.current = content;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  }, [content]);

  // Update language
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompartment.current.reconfigure(getLangExtension(language)),
    });
  }, [language]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      {searchOpen && cmView && (
        <SearchBar
          ref={searchBarRef}
          top="0px"
          onSearch={(q) => {
            const sq = new SearchQuery({ search: q });
            cmView.dispatch({ effects: setSearchQuery.of(sq) });
            if (q) findNext(cmView);
          }}
          onNext={() => findNext(cmView)}
          onPrev={() => findPrevious(cmView)}
          onClose={() => {
            cmView.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
            setSearchOpen(false);
            cmView.focus();
          }}
        />
      )}
    </div>
  );
}

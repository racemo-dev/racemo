import "./milkdown.css";
import { useEffect, useRef, useCallback } from "react";
import { Editor, rootCtx, defaultValueCtx, remarkPluginsCtx } from "@milkdown/core";
import remarkBreaks from "remark-breaks";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { clipboard } from "@milkdown/plugin-clipboard";
import { getMarkdown, replaceAll } from "@milkdown/utils";
import { $prose } from "@milkdown/utils";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { useThemeStore } from "../../stores/themeStore";
import DOMPurify from "dompurify";
import { logger } from "../../lib/logger";

interface MarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

const contentChangeKey = new PluginKey("contentChange");
const mermaidKey = new PluginKey("mermaid");

/** Cache: mermaid source → rendered SVG string */
const mermaidSvgCache = new Map<string, string>();
let mermaidMod: typeof import("mermaid").default | null = null;

/** Map app theme name to mermaid theme */
function toMermaidTheme(themeName: string): string {
  return themeName === "light" ? "default" : "dark";
}

async function getMermaid(themeName: string) {
  const mTheme = toMermaidTheme(themeName);
  const m = await import("mermaid");
  mermaidMod = m.default;
  mermaidMod.initialize({ startOnLoad: false, theme: mTheme as "default" | "dark" });
  return mermaidMod;
}

/**
 * Convert single newlines to hard breaks (two trailing spaces + newline)
 * so milkdown renders them as <br>. Skip lines that are already
 * block-level elements (headings, lists, blockquotes, code fences, blank lines, hr).
 */
function preprocessBreaks(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Toggle code fence
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) { result.push(line); continue; }

    const next = lines[i + 1];
    // Don't add trailing spaces if:
    // - current line is empty (paragraph break)
    // - current line already ends with two spaces
    // - current line is a block element (heading, list, blockquote, hr, code fence)
    // - next line is empty or a block element
    const isBlock = /^(\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|---|\*\*\*|___))/.test(line);
    const nextIsBlock = !next || next.trim() === "" || /^(\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|---|\*\*\*|___))/.test(next);
    const isEmpty = line.trim() === "";
    const alreadyHardBreak = line.endsWith("  ");

    if (!isEmpty && !alreadyHardBreak && !isBlock && !nextIsBlock) {
      result.push(line + "  ");
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}

/**
 * Wrap top-level HTML blocks in ```_html code fences so Milkdown can store them
 * as code_block nodes (which the decoration plugin renders as actual HTML widgets).
 */
function wrapHtmlBlocks(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let htmlBuf: string[] = [];
  let htmlDepth = 0;

  const BLOCK_TAGS = /^<\/?(p|div|h[1-6]|table|thead|tbody|tr|th|td|ul|ol|li|pre|blockquote|details|summary|section|article|nav|header|footer|figure|figcaption|picture|source)\b/i;
  const SELF_CLOSING = /^<(img|br|hr|input|meta|link|source)\b[^>]*\/?>/i;

  function flushHtml() {
    if (htmlBuf.length > 0) {
      result.push("```_html");
      result.push(...htmlBuf);
      result.push("```");
      htmlBuf = [];
      htmlDepth = 0;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Track code fences
    if (trimmed.startsWith("```")) {
      if (htmlBuf.length > 0) flushHtml();
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) { result.push(line); continue; }

    // Inside an HTML block accumulation
    if (htmlBuf.length > 0) {
      htmlBuf.push(line);
      // Count open/close tags to determine when the block ends
      const opens = (line.match(/<(?!\/)[a-z][^>]*(?<!\/)\s*>/gi) ?? []).length;
      const closes = (line.match(/<\/[a-z][^>]*>/gi) ?? []).length;
      htmlDepth += opens - closes;
      if (htmlDepth <= 0 && trimmed === "") {
        flushHtml();
      }
      continue;
    }

    // Detect start of HTML block
    if (trimmed.startsWith("<") && !trimmed.startsWith("<!--") && (BLOCK_TAGS.test(trimmed) || SELF_CLOSING.test(trimmed))) {
      htmlBuf.push(line);
      const opens = (line.match(/<(?!\/)[a-z][^>]*(?<!\/)\s*>/gi) ?? []).length;
      const selfClosing = (line.match(/<[a-z][^>]*\/\s*>/gi) ?? []).length;
      const closes = (line.match(/<\/[a-z][^>]*>/gi) ?? []).length;
      htmlDepth = opens - selfClosing - closes;
      // Single-line self-contained HTML
      if (htmlDepth <= 0) {
        flushHtml();
      }
      continue;
    }

    result.push(line);
  }
  flushHtml();
  return result.join("\n");
}

/**
 * Convert ```_html code fences back to raw HTML when extracting markdown.
 */
function unwrapHtmlBlocks(md: string): string {
  return md.replace(/```_html\n([\s\S]*?)```/g, (_, html: string) => html.trimEnd());
}

export default function MarkdownEditor({ content, onChange, onSave }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const contentRef = useRef(content);
  const isInternalChange = useRef(false);
  const editorVersion = useRef(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const themeName = useThemeStore((s) => s.themeName);
  const themeNameRef = useRef(themeName);
  useEffect(() => { themeNameRef.current = themeName; }, [themeName]);

  // Ref to dispatch a mermaid rebuild transaction (set by the plugin's view callback)
  const dispatchRebuildRef = useRef<(() => void) | null>(null);

  // When app theme changes: clear SVG cache and re-render all mermaid diagrams
  useEffect(() => {
    mermaidSvgCache.clear();
    mermaidMod = null; // force re-initialize with new theme
    dispatchRebuildRef.current?.();
  }, [themeName]);


  const initEditor = useCallback(async () => {
    if (!containerRef.current) return;

    // Cleanup
    if (editorRef.current) {
      const old = editorRef.current;
      editorRef.current = null;
      try { old.destroy(); } catch { /* expected: editor cleanup may fail after unmount */ }
    }
    containerRef.current.innerHTML = "";

    editorVersion.current++;
    const currentVersion = editorVersion.current;

    // Widget decoration plugin for mermaid diagrams and HTML blocks
    const widgetPlugin = $prose(() => {
      let viewRef: import("@milkdown/prose/view").EditorView | null = null;

      function buildDecorations(doc: import("@milkdown/prose/model").Node): DecorationSet {
        const currentTheme = themeNameRef.current;
        const cachePrefix = `${currentTheme}:`;
        const decos: Decoration[] = [];
        doc.forEach((node, offset) => {
          if (node.type.name !== "code_block") return;
          const lang = node.attrs?.language;

          // Mermaid diagrams
          if (lang === "mermaid") {
            const code = node.textContent.trim();
            if (!code) return;
            const cacheKey = `${cachePrefix}${code}`;
            const wrapper = document.createElement("div");
            wrapper.className = "mermaid-widget";
            wrapper.style.cssText = "overflow-x:auto;margin:0 0 8px 0;border-radius:6px;padding:12px;background:var(--bg-elevated);";

            if (mermaidSvgCache.has(cacheKey)) {
              wrapper.innerHTML = DOMPurify.sanitize(mermaidSvgCache.get(cacheKey)!, { USE_PROFILES: { svg: true, svgFilters: true } });
            } else {
              wrapper.style.color = "var(--text-muted,#888)";
              wrapper.textContent = "Rendering diagram\u2026";
              getMermaid(currentTheme).then(async (m) => {
                try {
                  const id = `mm-${Math.random().toString(36).slice(2)}`;
                  const { svg } = await m.render(id, code);
                  mermaidSvgCache.set(cacheKey, svg);
                  wrapper.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
                  wrapper.style.color = "";
                  try {
                    if (viewRef) viewRef.dispatch(viewRef.state.tr.setMeta("mermaid-rendered", true));
                  } catch { /* view may be destroyed */ }
                } catch (err) {
                  wrapper.style.color = "var(--accent-red,#e55)";
                  wrapper.textContent = `[mermaid error] ${String(err)}`;
                }
              });
            }
            decos.push(Decoration.widget(offset, wrapper, { side: -1, key: `mermaid-${currentTheme}-${code.slice(0, 40)}` }));
            decos.push(Decoration.node(offset, offset + node.nodeSize, { style: "display:none" }));
          }

          // HTML blocks (wrapped as ```_html)
          if (lang === "_html") {
            const html = node.textContent;
            if (!html.trim()) return;
            const wrapper = document.createElement("div");
            wrapper.className = "html-block-widget";
            wrapper.title = "HTML block — edit in Source mode";
            wrapper.innerHTML = DOMPurify.sanitize(html, {
              ADD_TAGS: ["img"],
              ADD_ATTR: ["align", "target", "src", "alt", "width", "height", "loading"],
            });
            decos.push(Decoration.widget(offset, wrapper, { side: -1, key: `html-${html.slice(0, 40)}` }));
            decos.push(Decoration.node(offset, offset + node.nodeSize, { style: "display:none" }));
          }
        });
        return DecorationSet.create(doc, decos);
      }

      return new Plugin({
        key: mermaidKey,
        state: {
          init(_, state) { return buildDecorations(state.doc); },
          apply(tr, old) {
            if (!tr.docChanged && !tr.getMeta("mermaid-rendered")) return old;
            return buildDecorations(tr.doc);
          },
        },
        view(editorView) {
          viewRef = editorView;
          dispatchRebuildRef.current = () => {
            try {
              if (viewRef) viewRef.dispatch(viewRef.state.tr.setMeta("mermaid-rendered", true));
            } catch { /* view may be destroyed */ }
          };
          return {
            destroy() {
              viewRef = null;
              dispatchRebuildRef.current = null;
            },
          };
        },
        props: {
          decorations(state) { return mermaidKey.getState(state) as DecorationSet; },
        },
      });
    });

    const contentChangePlugin = $prose(() => {
      return new Plugin({
        key: contentChangeKey,
        view: () => ({
          update: (view, prevState) => {
            if (currentVersion !== editorVersion.current || !editorRef.current) return;
            if (view.state.doc.eq(prevState.doc)) return;
            if (isInternalChange.current) return;

            try {
              const md = editorRef.current!.action(getMarkdown());
              const restored = unwrapHtmlBlocks(md);
              contentRef.current = restored;
              onChangeRef.current(restored);
            } catch { /* editor might be destroyed */ }
          },
        }),
      });
    });

    const prepared = wrapHtmlBlocks(preprocessBreaks(content || ""));

    try {
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, containerRef.current!);
          ctx.set(defaultValueCtx, prepared);
          // remark-breaks exports a unified Plugin, but milkdown expects { plugin, options } shape.
          // The runtime handles both forms; the type mismatch is a milkdown/unified interop issue.
          ctx.update(remarkPluginsCtx, (prev) => [...prev, remarkBreaks as unknown as (typeof prev)[number]]);
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(clipboard)
        .use(widgetPlugin)
        .use(contentChangePlugin)
        .create();

      editorRef.current = editor;
    } catch (e) {
      logger.error("Failed to initialize Milkdown:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor init must run once; content is read fresh inside
  }, []);

  useEffect(() => {
    initEditor();
    // Capture ref so cleanup function uses the version current at effect setup
    const cleanupVersion = editorVersion;
    return () => {
      cleanupVersion.current++;
      if (editorRef.current) {
        const old = editorRef.current;
        editorRef.current = null;
        try { old.destroy(); } catch { /* expected: editor cleanup may fail after unmount */ }
      }
    };
  }, [initEditor]);

  // Handle Ctrl+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    };
    const el = containerRef.current;
    el?.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => el?.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onSave]);

  // External content update (tab switch)
  useEffect(() => {
    if (!editorRef.current || content === contentRef.current) return;
    isInternalChange.current = true;
    contentRef.current = content;
    try {
      editorRef.current.action(replaceAll(wrapHtmlBlocks(preprocessBreaks(content))));
    } catch { /* expected: editor may be destroyed during tab switch */ }
    setTimeout(() => { isInternalChange.current = false; }, 0);
  }, [content]);

  return (
    <div
      ref={containerRef}
      className="milkdown-editor h-full w-full overflow-auto"
      spellCheck={false}
      style={{
        padding: "24px 48px",
        fontSize: "var(--fs-12)",
        lineHeight: 1.7,
        color: "var(--text-primary)",
        background: "var(--bg-base)",
      }}
    />
  );
}

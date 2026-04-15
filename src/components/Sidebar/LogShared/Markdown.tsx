/**
 * Markdown rendering components for AI log panels.
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

/* ─── Markdown content with DOMPurify sanitization ─── */

/**
 * Renders markdown content safely using DOMPurify.sanitize().
 * DOMPurify with default config strips all dangerous HTML (scripts, event handlers, etc.)
 * which is sufficient for rendering AI log content.
 */
export function MarkdownContent({ content, className, preprocess }: {
  content: string;
  className: string;
  preprocess?: (text: string) => string;
}) {
  const html = (() => {
    try {
      const text = preprocess ? preprocess(content) : content;
      return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    } catch {
      return DOMPurify.sanitize(content);
    }
  })();

  return (
    <span
      dangerouslySetInnerHTML={{ __html: html }}
      style={{ display: "block" }}
      className={className}
    />
  );
}

/* ─── Log markdown CSS (shared across all providers) ─── */

export function LogMdStyles({ prefix }: { prefix: string }) {
  return (
    <style>{`
      .${prefix} p { margin: 0 0 4px 0; }
      .${prefix} p:last-child { margin-bottom: 0; }
      .${prefix} strong { color: var(--text-primary); font-weight: 700; }
      .${prefix} em { color: var(--accent-blue); font-style: italic; }
      .${prefix} code { background: var(--bg-overlay); color: var(--accent-red); padding: 1px 4px; border-radius: 3px; font-size: var(--fs-9); font-family: var(--font-mono, monospace); }
      .${prefix} pre { background: var(--bg-overlay); border-radius: 4px; padding: 6px 8px; overflow-x: auto; margin: 4px 0; }
      .${prefix} pre code { background: none; padding: 0; color: var(--text-secondary); }
      .${prefix} ul, .${prefix} ol { margin: 2px 0 4px 16px; padding: 0; }
      .${prefix} li { margin: 1px 0; }
      .${prefix} h1, .${prefix} h2, .${prefix} h3 { color: var(--text-primary); font-weight: 700; margin: 4px 0 2px 0; font-size: var(--fs-11); }
      .${prefix} a { color: var(--accent-blue); text-decoration: underline; }
      .${prefix} blockquote { border-left: 2px solid var(--border-subtle); margin: 4px 0; padding-left: 8px; color: var(--text-muted); }
      .${prefix} table { border-collapse: collapse; width: 100%; margin: 4px 0; font-size: var(--fs-9); }
      .${prefix} th, .${prefix} td { border: 1px solid var(--border-default); padding: 2px 6px; text-align: left; }
      .${prefix} th { background: var(--bg-overlay); color: var(--text-primary); font-weight: 600; }
      .${prefix} tr:nth-child(even) td { background: var(--bg-subtle); }
    `}</style>
  );
}

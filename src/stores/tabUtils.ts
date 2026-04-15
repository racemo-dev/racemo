/**
 * Shared tab management utilities used by editorStore and panelEditorStore.
 * All functions are pure — they take state in and return new state out.
 */

interface TabResult<T> {
  tabs: T[];
  activeIndex: number;
}

export function closeTab<T>(tabs: T[], index: number, activeIndex: number): TabResult<T> {
  const next = tabs.filter((_, i) => i !== index);
  let nextActive = activeIndex;
  if (index <= activeIndex) nextActive = Math.max(0, activeIndex - 1);
  if (next.length === 0) nextActive = 0;
  return { tabs: next, activeIndex: nextActive };
}

export function closeOthers<T>(tabs: T[], index: number): TabResult<T> {
  return { tabs: [tabs[index]], activeIndex: 0 };
}

export function closeToRight<T>(tabs: T[], index: number, activeIndex: number): TabResult<T> {
  return { tabs: tabs.slice(0, index + 1), activeIndex: Math.min(activeIndex, index) };
}

export function closeAll(): TabResult<never> {
  return { tabs: [], activeIndex: 0 };
}

export function moveTab<T>(tabs: T[], from: number, to: number, activeIndex: number): TabResult<T> {
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  let active = activeIndex;
  if (from === active) active = to;
  else if (from < active && to >= active) active--;
  else if (from > active && to <= active) active++;
  return { tabs: next, activeIndex: active };
}

/**
 * Find tab index by path and return it, or -1 if not found.
 * Used by reloadTabByPath in both stores.
 */
export function findTabIndexByPath<T extends { path: string }>(tabs: T[], path: string): number {
  return tabs.findIndex((t) => t.path === path);
}

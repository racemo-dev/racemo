export const MIN_WIDTH = 280;

export interface CtxMenuState { x: number; y: number; index: number }

export function getDisplayNames(tabs: { name: string; path: string }[]): string[] {
  const names = tabs.map((t) => t.name);
  return names.map((name, i) => {
    const dupes = names.filter((n) => n === name);
    if (dupes.length <= 1) return name;
    const parts = tabs[i].path.replace(/\\/g, "/").split("/");
    const parent = parts[parts.length - 2] ?? "";
    return parent ? `${parent}/${name}` : name;
  });
}

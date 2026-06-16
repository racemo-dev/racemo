import type { WebglAddon } from "@xterm/addon-webgl";

/**
 * Workaround for an upstream @xterm/addon-webgl 0.19.0 bug (fixed upstream in
 * 0.20.0-beta by making AtlasPage.version globally monotonic).
 *
 * In 0.19.0, AtlasPage.version is a per-page counter starting at 0. When the
 * shared texture atlas hits the page limit (CJK-heavy output creates thousands
 * of unique glyphs), 4 pages are merged into one. The merged page is always
 * created with version 1 and always lands at the same array index
 * (pages.length - 4). GlyphRenderer decides texture re-uploads by comparing
 * pages[i].version against the version it last uploaded at slot i — so from
 * the second merge onward the new merged page is indistinguishable from the
 * previous one (same index, same version 1) and its GPU texture is never
 * re-uploaded. Cells then sample stale texture data: missing or fragmented
 * glyphs that persist until something resets texture versions (window resize,
 * clearTextureAtlas, addon re-create).
 *
 * Atlas page removal only ever happens during a merge, so
 * onRemoveTextureAtlasCanvas fires exactly when page indices/versions become
 * ambiguous. Marking every GL texture slot as stale (version = -1, the same
 * "needs upload" value GlyphRenderer.setAtlas uses) forces a full texture
 * re-upload on the next frame — a few texImage2D calls, no glyph
 * re-rasterization. The shared atlas forwards the event to every terminal
 * that owns it, so idle panes heal on their next render as well.
 *
 * TODO: remove when upgrading to @xterm/addon-webgl >= 0.20.0.
 */
let fireCount = 0;

/** Number of times the merge workaround has invalidated textures (diagnostics). */
export function getAtlasFixFireCount(): number {
  return fireCount;
}

/**
 * Mark every GPU texture slot of this renderer as stale (version = -1, the
 * same "needs upload" value GlyphRenderer.setAtlas uses) so the next frame
 * re-uploads all atlas pages from their intact canvases. Unlike
 * clearTextureAtlas() this does NOT wipe the shared glyph cache — no
 * re-rasterization storm, no atlas bookkeeping churn. Returns false if the
 * 0.19.0 internals were not found (workaround no-ops).
 */
export function invalidateAtlasTextures(addon: WebglAddon): boolean {
  try {
    // Private internals of the pinned 0.19.0 build. Property names survive
    // minification in the published bundle. `_renderer` is the WebglRenderer
    // in 0.19.0; tolerate a MutableDisposable wrapper (`.value`) in case a
    // patch release changes the shape. If anything is missing this no-ops.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const addonAny = addon as any;
    const renderer = addonAny._renderer?.value ?? addonAny._renderer;
    const textures = renderer?._glyphRenderer?.value?._atlasTextures;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (Array.isArray(textures)) {
      for (const t of textures) {
        t.version = -1;
      }
      return true;
    }
  } catch {
    // Never let the workaround break rendering.
  }
  return false;
}

/**
 * After clearTextureAtlas(), 0.19.0 (and current master) leaves stale glyph
 * bookkeeping on atlas pages: _glyphs/_usedPixels are not reset and pages
 * removed from _activePages (merged ones) are never re-activated. A later
 * page merge derives deletion indexes from glyphs[0].texturePage of those
 * stale lists and can delete the WRONG page — permanently corrupting live
 * cache entries (multi-glyph striped rendering). Scrub the bookkeeping right
 * after a cache wipe so the wipe is actually safe, and re-activate all pages
 * so their space is reused instead of orphaned.
 */
export function scrubAtlasAfterClear(addon: WebglAddon): void {
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const addonAny = addon as any;
    const renderer = addonAny._renderer?.value ?? addonAny._renderer;
    const atlas = renderer?._charAtlas;
    const pages = atlas?._pages;
    const active = atlas?._activePages;
    if (!Array.isArray(pages) || !Array.isArray(active)) return;
    for (const p of pages) {
      if (Array.isArray(p._glyphs)) p._glyphs.length = 0;
      if (typeof p._usedPixels === "number") p._usedPixels = 0;
      if (!active.includes(p)) active.push(p);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  } catch {
    // Never let the workaround break rendering.
  }
}

export function installAtlasMergeWorkaround(addon: WebglAddon): void {
  // Set when a merge fires while this terminal's render pass is executing.
  // Page merges happen synchronously inside _drawToCache → _updateModel, so
  // cells written before the merge carry pre-merge texture coordinates while
  // later cells carry post-merge ones — the frame drawn from that pass is
  // internally inconsistent (visible as a one-frame glyph scramble).
  let mergedDuringPass = false;

  addon.onRemoveTextureAtlasCanvas(() => {
    if (invalidateAtlasTextures(addon)) {
      mergedDuringPass = true;
      fireCount++;
      // Direct console.info (not logger): logger gates console output behind
      // dev builds, but this needs to be visible when inspecting production
      // sessions where the corruption actually reproduces. Merges are rare
      // enough in real use that this is not noisy.
      // eslint-disable-next-line no-console
      console.info("[webglAtlasFix] atlas page merge — texture versions invalidated");
    }
  });

  // Merge-frame guard: wrap renderRows so a pass that contained a merge is
  // immediately redrawn within the same JS task. WebGL presents only the
  // final state of the task to the compositor, so the inconsistent draw
  // never reaches the screen — the merge becomes visually seamless instead
  // of a one-frame flicker. Deferred a microtask so the addon is activated
  // (registries call loadAddon synchronously after this).
  queueMicrotask(() => {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const addonAny = addon as any;
      // If the addon was disposed before this microtask ran (e.g. recovery
      // re-created it within the same task), don't wrap the dying renderer.
      if (addonAny._store?._isDisposed) return;
      const renderer = addonAny._renderer?.value ?? addonAny._renderer;
      const terminal = addonAny._terminal;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (!renderer || typeof renderer.renderRows !== "function" || !terminal) return;
      const orig = renderer.renderRows.bind(renderer);
      renderer.renderRows = (start: number, end: number) => {
        mergedDuringPass = false;
        orig(start, end);
        if (mergedDuringPass) {
          // Single retry: glyph coordinates are consistent now and textures
          // were invalidated, so this pass draws clean. If the retry itself
          // triggers another merge (extreme stress), let the next natural
          // frame heal it rather than looping.
          mergedDuringPass = false;
          orig(0, terminal.rows - 1);
        }
      };
    } catch {
      // Guard is best-effort; without it merges remain a one-frame flicker.
    }
  });
}

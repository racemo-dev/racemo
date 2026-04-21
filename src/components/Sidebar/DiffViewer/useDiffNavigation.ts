import { useCallback, useEffect, useRef, useState } from "react";
import { useThemeStore } from "../../../stores/themeStore";
import { LINE_H_BASE } from "./constants";

export function useDiffNavigation(
  changeBlocks: { offset: number }[],
  displayDiff: string | null,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onClose?: () => void,
  setDiffFontSize?: React.Dispatch<React.SetStateAction<number>>,
) {
  const uiScale = useThemeStore((s) => s.fontSize / 12);
  const LINE_H = LINE_H_BASE * uiScale;
  const [currentChangeIdx, setCurrentChangeIdx] = useState(-1);
  const changeCount = changeBlocks.length;

  const navigateToChange = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= changeBlocks.length) return;
      setCurrentChangeIdx(idx);
      const scrollTo = Math.max(0, changeBlocks[idx].offset - LINE_H * 3);
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTo;
    },
    [changeBlocks, scrollRef, LINE_H],
  );

  const goNext = useCallback(() => {
    navigateToChange(currentChangeIdx < changeCount - 1 ? currentChangeIdx + 1 : 0);
  }, [currentChangeIdx, changeCount, navigateToChange]);

  const goPrev = useCallback(() => {
    navigateToChange(currentChangeIdx > 0 ? currentChangeIdx - 1 : changeCount - 1);
  }, [currentChangeIdx, changeCount, navigateToChange]);

  // Keyboard shortcuts
  const goNextRef = useRef<() => void>(() => { });
  const goPrevRef = useRef<() => void>(() => { });

  useEffect(() => { goNextRef.current = goNext; }, [goNext]);
  useEffect(() => { goPrevRef.current = goPrev; }, [goPrev]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose?.(); return; }
      if (e.key === "ArrowDown" && (e.metaKey || e.altKey)) { e.preventDefault(); goNextRef.current(); }
      if (e.key === "ArrowUp" && (e.metaKey || e.altKey)) { e.preventDefault(); goPrevRef.current(); }
      if (e.key === "F8" || (e.key === "ArrowDown" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); goNextRef.current(); }
      if ((e.key === "F8" && e.shiftKey) || (e.key === "ArrowUp" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); goPrevRef.current(); }
      // Ctrl+/- font zoom
      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); setDiffFontSize?.((s) => Math.min(s + 1, 24)); }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); setDiffFontSize?.((s) => Math.max(s - 1, 8)); }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, setDiffFontSize]);

  // Auto-navigate to first change when diff loads
  useEffect(() => {
    if (changeBlocks.length > 0) {
      setCurrentChangeIdx(0);
      const scrollTo = Math.max(0, changeBlocks[0].offset - LINE_H * 3);
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTo;
    } else {
      setCurrentChangeIdx(-1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayDiff]);

  return { currentChangeIdx, changeCount, goNext, goPrev };
}

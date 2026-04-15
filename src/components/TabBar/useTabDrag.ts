import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { isModKey } from "../../lib/osUtils";
import { logger } from "../../lib/logger";
import type { Session } from "../../types/session";

const DRAG_THRESHOLD = 5;

export function useTabDrag(sessions: Session[], activeSessionId: string | null, editingId: string | null) {
  const reorderSessions = useSessionStore((s) => s.reorderSessions);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragStartIndex = useRef<number | null>(null);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);

  const findDropTarget = useCallback((clientX: number): number | null => {
    const len = sessions.length;
    for (let i = 0; i < len; i++) {
      const el = tabRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        return i;
      }
    }
    const firstEl = tabRefs.current[0];
    if (firstEl && clientX < firstEl.getBoundingClientRect().left) {
      return 0;
    }
    const lastEl = tabRefs.current[len - 1];
    if (lastEl && clientX > lastEl.getBoundingClientRect().right) {
      return len - 1;
    }
    return null;
  }, [sessions]);

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    if (editingId) return;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragStartIndex.current = index;
    isDragging.current = false;
    const tabEl = tabRefs.current[index];
    if (tabEl) {
      const rect = tabEl.getBoundingClientRect();
      dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
  }, [editingId]);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (dragStartPos.current === null || dragStartIndex.current === null) return;

      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;

      if (!isDragging.current) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        isDragging.current = true;
        setDragIndex(dragStartIndex.current);
      }

      setGhostPos({ x: e.clientX - dragOffset.current.x, y: dragStartPos.current!.y - dragOffset.current.y });

      const target = findDropTarget(e.clientX);
      const next = target !== null && target !== dragStartIndex.current ? target : null;
      dropIndexRef.current = next;
      setDropIndex(next);
    };

    const handlePointerUp = () => {
      const di = dropIndexRef.current;
      const from = dragStartIndex.current;
      if (isDragging.current && from !== null && di !== null && from !== di) {
        reorderSessions(from, di);
      }
      dragStartPos.current = null;
      dragStartIndex.current = null;
      dropIndexRef.current = null;
      isDragging.current = false;
      setDragIndex(null);
      setDropIndex(null);
      setGhostPos(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [findDropTarget, reorderSessions]);

  // Keyboard shortcut: Ctrl+Shift+Left/Right to move active tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModKey(e) || !e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (!activeSessionId) return;

      const currentIndex = sessions.findIndex((s) => s.id === activeSessionId);
      if (currentIndex === -1) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowLeft" && currentIndex > 0) {
        logger.debug("[TabBar] keyboard move left:", currentIndex, "->", currentIndex - 1);
        reorderSessions(currentIndex, currentIndex - 1);
      } else if (e.key === "ArrowRight" && currentIndex < sessions.length - 1) {
        logger.debug("[TabBar] keyboard move right:", currentIndex, "->", currentIndex + 1);
        reorderSessions(currentIndex, currentIndex + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [sessions, activeSessionId, reorderSessions]);

  return {
    dragIndex,
    dropIndex,
    ghostPos,
    isDragging,
    tabRefs,
    handlePointerDown,
  };
}

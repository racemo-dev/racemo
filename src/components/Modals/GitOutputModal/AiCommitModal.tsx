import { useEffect, useRef, useState } from "react";
import { ResizeHandles } from "./ResizeHandles";
import { AiCommitPanel } from "./AiCommitPanel";
import type { ModalSizeProps } from "./types";

const FLOAT_MARGIN = 16;

/**
 * AI 자동 커밋 — 분리(floating) 모드의 shell.
 * 드래그·리사이즈·우측 하단 기본 위치를 담당하고, 내용은 AiCommitPanel에 위임.
 */
export function AiCommitModal({ size, setSize, onResizeMouseDown, justResized }: ModalSizeProps) {
  // 비차단 플로팅 패널 위치 — 기본은 우측 하단, 헤더 드래그로 이동 가능
  const [position, setPosition] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(FLOAT_MARGIN, window.innerWidth - size.width - FLOAT_MARGIN),
    y: Math.max(FLOAT_MARGIN, window.innerHeight - size.height - FLOAT_MARGIN),
  }));
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  void setSize;
  void justResized;

  // 윈도우 리사이즈 시 패널이 화면 밖으로 나가지 않도록 보정
  useEffect(() => {
    const clamp = () => {
      setPosition((prev) => {
        const maxX = Math.max(0, window.innerWidth - size.width);
        const maxY = Math.max(0, window.innerHeight - size.height);
        const x = Math.min(Math.max(0, prev.x), maxX);
        const y = Math.min(Math.max(0, prev.y), maxY);
        if (x === prev.x && y === prev.y) return prev;
        return { x, y };
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [size.width, size.height]);

  const onDragMouseDown = (e: React.MouseEvent) => {
    // 헤더 내부 버튼/인터랙티브 요소 클릭은 드래그로 처리하지 않음
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragging.current = { startX: e.clientX, startY: e.clientY, baseX: position.x, baseY: position.y };
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const { startX, startY, baseX, baseY } = dragging.current;
      const maxX = Math.max(0, window.innerWidth - size.width);
      const maxY = Math.max(0, window.innerHeight - size.height);
      const x = Math.min(Math.max(0, baseX + (ev.clientX - startX)), maxX);
      const y = Math.min(Math.max(0, baseY + (ev.clientY - startY)), maxY);
      setPosition({ x, y });
    };
    const onUp = () => {
      dragging.current = null;
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 9999,
        width: size.width, height: size.height,
        maxWidth: "95vw", maxHeight: "95vh",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 12,
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,0.7)",
      }}
    >
      <AiCommitPanel
        variant="floating"
        onHeaderMouseDown={onDragMouseDown}
        isDragging={isDragging}
      />
      <ResizeHandles onResizeMouseDown={onResizeMouseDown} />
    </div>
  );
}

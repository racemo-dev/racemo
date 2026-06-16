import { useRef, useState, useCallback } from "react";
import { useGitOutputStore } from "../../../stores/gitOutputStore";
import { BrowserHideGuard } from "../../Editor/BrowserViewer";
import { AiCommitModal } from "./AiCommitModal";
import { TerminalModal } from "./TerminalModal";

export default function GitOutputModal() {
  const isOpen = useGitOutputStore((s) => s.isOpen);
  const mode = useGitOutputStore((s) => s.mode);
  const aiCommitLocation = useGitOutputStore((s) => s.aiCommitLocation);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 560, height: 620 });
  const resizing = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number } | null>(null);
  const justResized = useRef(false);

  const onResizeMouseDown = useCallback((e: React.MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = { edge, startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const { edge, startX, startY, startW, startH } = resizing.current;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setSize({
        width: edge.includes("e") ? Math.max(320, startW + dx)
             : edge.includes("w") ? Math.max(320, startW - dx)
             : startW,
        height: edge.includes("s") ? Math.max(200, startH + dy)
              : edge.includes("n") ? Math.max(200, startH - dy)
              : startH,
      });
    };
    const onUp = () => {
      resizing.current = null;
      justResized.current = true;
      setTimeout(() => { justResized.current = false; }, 100);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [size]);

  if (!isOpen) return null;

  // ai-commit + inline 모드는 사이드바 CommitForm 안에서 렌더하므로 여기선 아무것도 띄우지 않는다.
  if (mode === "ai-commit" && aiCommitLocation === "inline") return null;

  return <>
    {/* ai-commit 플로팅 패널은 작은 비차단 패널이라 뒤의 브라우저 웹뷰를 숨길 필요가 없다 */}
    {mode !== "ai-commit" && <BrowserHideGuard />}
    {mode === "ai-commit"
      ? <AiCommitModal size={size} setSize={setSize} onResizeMouseDown={onResizeMouseDown} justResized={justResized} />
      : <TerminalModal size={size} setSize={setSize} onResizeMouseDown={onResizeMouseDown} scrollRef={scrollRef as React.RefObject<HTMLDivElement>} justResized={justResized} />}
  </>;
}

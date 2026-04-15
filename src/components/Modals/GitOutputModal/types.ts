import type React from "react";

export interface ModalSizeProps {
  size: { width: number; height: number };
  setSize: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>;
  onResizeMouseDown: (e: React.MouseEvent, edge: string) => void;
  justResized: React.MutableRefObject<boolean>;
}

export interface TerminalModalProps extends ModalSizeProps {
  scrollRef: React.RefObject<HTMLDivElement>;
}

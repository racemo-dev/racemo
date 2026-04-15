import { useRef, useCallback } from "react";

export default function HorizontalDivider({ onDrag }: { onDrag: (deltaY: number) => void }) {
    const dragging = useRef(false);
    const lastY = useRef(0);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragging.current = true;
            lastY.current = e.clientY;

            const onMouseMove = (ev: MouseEvent) => {
                if (!dragging.current) return;
                const delta = ev.clientY - lastY.current;
                lastY.current = ev.clientY;
                onDrag(delta);
            };

            const onMouseUp = () => {
                dragging.current = false;
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            };

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        },
        [onDrag]
    );

    return (
        <div
            onMouseDown={onMouseDown}
            style={{
                height: 4,
                cursor: "row-resize",
                background: "var(--border-subtle)",
                flexShrink: 0,
            }}
        />
    );
}

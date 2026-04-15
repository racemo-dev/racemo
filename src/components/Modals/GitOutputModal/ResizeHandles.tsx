export function ResizeHandles({ onResizeMouseDown }: { onResizeMouseDown: (e: React.MouseEvent, edge: string) => void }) {
  return (
    <>
      {(["e","w","s","se","sw"] as const).map((edge) => (
        <div
          key={edge}
          onMouseDown={(e) => onResizeMouseDown(e, edge)}
          style={{
            position: "absolute",
            ...(edge === "e"  && { right: 0, top: 8, bottom: 8, width: 6, cursor: "ew-resize" }),
            ...(edge === "w"  && { left: 0, top: 8, bottom: 8, width: 6, cursor: "ew-resize" }),
            ...(edge === "s"  && { bottom: 0, left: 8, right: 8, height: 6, cursor: "ns-resize" }),
            ...(edge === "se" && { right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize" }),
            ...(edge === "sw" && { left: 0, bottom: 0, width: 14, height: 14, cursor: "nesw-resize" }),
          }}
        />
      ))}
    </>
  );
}

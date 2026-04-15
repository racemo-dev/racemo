import { useState } from "react";
import type { HookTreeNode } from "../../../types/hooklog";
import { ChevronIcon, nodeIcon, ModelBadge, statusColor, statusDot } from "./helpers";

export function TreeNode({
  node,
  depth,
  onHover,
  onHoverLeave,
}: {
  node: HookTreeNode;
  depth: number;
  onHover: (node: HookTreeNode, rect: DOMRect) => void;
  onHoverLeave: () => void;
}) {
  const hasChildren = node.children.length > 0;
  const [isOpen, setIsOpen] = useState(depth < 1);

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 cursor-pointer select-none"
        style={{
          paddingLeft: depth * 12 + 4,
          fontSize: "var(--fs-12)",
          color: statusColor(node.status) ?? "var(--text-secondary)",
          userSelect: "none",
        }}
        onClick={() => { if (hasChildren) setIsOpen((p) => !p); }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--bg-overlay)";
          onHover(node, e.currentTarget.getBoundingClientRect());
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          onHoverLeave();
        }}
      >
        {hasChildren ? <ChevronIcon open={isOpen} /> : <span style={{ width: 14, flexShrink: 0 }} />}
        {nodeIcon(node)}
        {node.node_type === "session" && node.model && <ModelBadge model={node.model} />}
        <span className="truncate">{node.label}</span>
        {statusDot(node.status)}
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} onHover={onHover} onHoverLeave={onHoverLeave} />
          ))}
        </div>
      )}
    </div>
  );
}

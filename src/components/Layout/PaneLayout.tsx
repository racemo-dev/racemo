import type { PaneNode } from "../../types/session";
import TerminalPane from "../Terminal/TerminalPane";
import RemoteTerminalPane from "../Terminal/RemoteTerminalPane";
import Splitter from "./Splitter";

interface PaneLayoutProps {
  node: PaneNode;
  isRemote?: boolean;
}

export default function PaneLayout({ node, isRemote }: PaneLayoutProps) {
  if (node.type === "leaf") {
    if (isRemote) {
      return <RemoteTerminalPane paneId={node.id} remotePaneId={node.ptyId} shell={node.shell} />;
    }
    return <TerminalPane paneId={node.id} ptyId={node.ptyId} initialCwd={node.cwd} lastCommand={node.lastCommand} />;
  }

  const isHorizontal = node.direction === "horizontal";

  return (
    <div
      className="flex w-full h-full"
      style={{ flexDirection: isHorizontal ? "row" : "column" }}
    >
      <div
        className="overflow-hidden min-w-0 min-h-0"
        style={{ flex: `${node.ratio} 1 0%` }}
      >
        <PaneLayout node={node.first} isRemote={isRemote} />
      </div>
      <Splitter splitId={node.id} direction={node.direction} />
      <div
        className="overflow-hidden min-w-0 min-h-0"
        style={{ flex: `${1 - node.ratio} 1 0%` }}
      >
        <PaneLayout node={node.second} isRemote={isRemote} />
      </div>
    </div>
  );
}

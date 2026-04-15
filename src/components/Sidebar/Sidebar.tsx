import { useSidebarStore } from "../../stores/sidebarStore";
import IconStrip from "./IconStrip";
import SidebarPanel from "./SidebarPanel";

export default function Sidebar() {
  const isExpanded = useSidebarStore((s) => s.isExpanded);

  return (
    <div className="flex h-full shrink-0 no-drag" style={{ borderRight: "1px solid var(--border-default)" }}>
      <IconStrip />
      {isExpanded && <SidebarPanel />}
    </div>
  );
}

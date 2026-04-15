import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, CloudArrowDown, Tag, Archive, CaretRight, CaretDown, CheckCircle } from "@phosphor-icons/react";
import type { GitRefList } from "../../../types/git";

const SECTION_STYLE: React.CSSProperties = {
    fontSize: "var(--fs-11)",
    color: "var(--text-secondary)",
    userSelect: "none",
};

function Section({
    label,
    icon,
    sectionKey,
    count,
    children,
    expanded,
    onToggle,
}: {
    label: string;
    icon: React.ReactNode;
    sectionKey: string;
    count: number;
    children: React.ReactNode;
    expanded: boolean;
    onToggle: (key: string) => void;
}) {
    return (
        <div style={{ marginBottom: 2 }}>
            <div
                className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-[var(--bg-overlay)]"
                style={SECTION_STYLE}
                onClick={() => onToggle(sectionKey)}
            >
                {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
                {icon}
                <span>{label}</span>
                {count > 0 && (
                    <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-9)", marginLeft: 4 }}>
                        ({count})
                    </span>
                )}
            </div>
            {expanded && children}
        </div>
    );
}

function RemoteGroup({ name, branches }: { name: string; branches: string[] }) {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ paddingLeft: 12 }}>
            <div
                className="flex items-center gap-1 cursor-pointer"
                style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", paddingTop: 1, paddingBottom: 1 }}
                onClick={() => setOpen(!open)}
            >
                {open ? <CaretDown size={9} /> : <CaretRight size={9} />}
                <CloudArrowDown size={10} />
                <span>{name}</span>
            </div>
            {open &&
                branches.map((b) => (
                    <div
                        key={b}
                        className="truncate"
                        style={{
                            fontSize: "var(--fs-10)",
                            color: "var(--text-muted)",
                            paddingLeft: 22,
                            paddingTop: 1,
                            paddingBottom: 1,
                        }}
                    >
                        {b}
                    </div>
                ))}
        </div>
    );
}

export default function RefsTree({ cwd }: { cwd: string }) {
    const [refs, setRefs] = useState<GitRefList | null>(null);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({
        branches: true,
        remotes: true,
        tags: false,
        stashes: false,
    });

    useEffect(() => {
        invoke<GitRefList>("git_ref_list", { path: cwd })
            .then(setRefs)
            .catch(console.error);
    }, [cwd]);

    const toggle = (key: string) =>
        setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

    const itemStyle: React.CSSProperties = {
        fontSize: "var(--fs-11)",
        color: "var(--text-muted)",
        paddingLeft: 20,
        paddingTop: 2,
        paddingBottom: 2,
        cursor: "default",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
    };

    if (!refs) return null;

    // Group remotes by remote name (e.g., "origin/main" -> origin -> [main])
    const remoteGroups: Record<string, string[]> = {};
    for (const rb of refs.remoteBranches) {
        const slash = rb.indexOf("/");
        const remote = slash > 0 ? rb.substring(0, slash) : "origin";
        const branch = slash > 0 ? rb.substring(slash + 1) : rb;
        if (!remoteGroups[remote]) remoteGroups[remote] = [];
        remoteGroups[remote].push(branch);
    }

    return (
        <div
            style={{
                width: 180,
                minWidth: 180,
                borderRight: "1px solid var(--border-subtle)",
                overflow: "auto",
                background: "var(--bg-surface)",
            }}
        >
            {/* Branches */}
            <Section
                label="Branches"
                icon={<GitBranch size={12} weight="bold" />}
                sectionKey="branches"
                count={refs.localBranches.length}
                expanded={expanded.branches}
                onToggle={toggle}
            >
                {refs.localBranches.map((b) => (
                    <div
                        key={b}
                        className="flex items-center gap-1"
                        style={{
                            ...itemStyle,
                            color: b === refs.currentBranch ? "var(--text-primary)" : "var(--text-muted)",
                            fontWeight: b === refs.currentBranch ? 600 : 400,
                        }}
                    >
                        {b === refs.currentBranch && (
                            <CheckCircle size={10} weight="fill" style={{ color: "var(--accent-green)", flexShrink: 0 }} />
                        )}
                        <span className="truncate">{b}</span>
                    </div>
                ))}
            </Section>

            {/* Remotes */}
            <Section
                label="Remotes"
                icon={<CloudArrowDown size={12} />}
                sectionKey="remotes"
                count={Object.keys(remoteGroups).length}
                expanded={expanded.remotes}
                onToggle={toggle}
            >
                {Object.entries(remoteGroups).map(([remote, branches]) => (
                    <RemoteGroup key={remote} name={remote} branches={branches} />
                ))}
            </Section>

            {/* Tags */}
            <Section
                label="Tags"
                icon={<Tag size={12} />}
                sectionKey="tags"
                count={refs.tags.length}
                expanded={expanded.tags}
                onToggle={toggle}
            >
                {refs.tags.map((tag) => (
                    <div key={tag} style={itemStyle}>{tag}</div>
                ))}
            </Section>

            {/* Stashes */}
            <Section
                label="Stashes"
                icon={<Archive size={12} />}
                sectionKey="stashes"
                count={refs.stashes.length}
                expanded={expanded.stashes}
                onToggle={toggle}
            >
                {refs.stashes.map((s, i) => (
                    <div key={i} style={itemStyle} className="truncate">{s}</div>
                ))}
            </Section>
        </div>
    );
}

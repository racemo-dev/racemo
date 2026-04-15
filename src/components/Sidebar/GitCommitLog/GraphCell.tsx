import { CheckCircle } from "@phosphor-icons/react";
import { GRAPH_COLORS } from "../../../lib/gitGraph";
import type { GraphRow } from "../../../lib/gitGraph";
import { LANE_WIDTH, ROW_HEIGHT, DOT_R, DOT_R_HEAD, GRAPH_PADDING } from "./constants";

/** Render the SVG graph cell for a single commit row. */
export function GraphCell({
    row,
    isFirst,
    isLast,
    isHead,
    isSelected,
    graphWidth,
}: {
    row: GraphRow;
    isFirst: boolean;
    isLast: boolean;
    isHead: boolean;
    isSelected: boolean;
    graphWidth: number;
}) {
    const cx = GRAPH_PADDING + row.col * LANE_WIDTH;
    const cy = ROW_HEIGHT / 2;

    return (
        <svg
            width={graphWidth}
            height={ROW_HEIGHT}
            style={{ flexShrink: 0, display: "block" }}
        >
            {/* Pass-through vertical lines */}
            {row.lines
                .filter((l) => l.type === "pass")
                .map((l, idx) => {
                    const x = GRAPH_PADDING + l.fromCol * LANE_WIDTH;
                    const isCommitLane = l.fromCol === row.col;
                    return (
                        <line
                            key={`p-${idx}`}
                            x1={x}
                            y1={isFirst && isCommitLane ? cy : 0}
                            x2={x}
                            y2={isLast && isCommitLane ? cy : ROW_HEIGHT}
                            stroke={GRAPH_COLORS[l.color % GRAPH_COLORS.length]}
                            strokeWidth={2}
                            opacity={0.8}
                        />
                    );
                })}

            {/* Merge lines (diagonal from another column down to commit) */}
            {row.lines
                .filter((l) => l.type === "merge-down")
                .map((l, idx) => {
                    const fromX = GRAPH_PADDING + l.fromCol * LANE_WIDTH;
                    const toX = GRAPH_PADDING + l.toCol * LANE_WIDTH;
                    const color = GRAPH_COLORS[l.color % GRAPH_COLORS.length];
                    return (
                        <path
                            key={`m-${idx}`}
                            d={`M ${fromX} 0 L ${fromX} ${cy * 0.4} C ${fromX} ${cy * 0.8}, ${toX} ${cy * 0.8}, ${toX} ${cy}`}
                            fill="none"
                            stroke={color}
                            strokeWidth={2}
                            opacity={0.8}
                        />
                    );
                })}

            {/* Branch-off lines (from commit down to a new column) */}
            {row.lines
                .filter((l) => l.type === "branch-up")
                .map((l, idx) => {
                    const fromX = GRAPH_PADDING + l.fromCol * LANE_WIDTH;
                    const toX = GRAPH_PADDING + l.toCol * LANE_WIDTH;
                    const color = GRAPH_COLORS[l.color % GRAPH_COLORS.length];
                    return (
                        <path
                            key={`b-${idx}`}
                            d={`M ${fromX} ${cy} C ${fromX} ${cy + cy * 0.6}, ${toX} ${cy + cy * 0.2}, ${toX} ${ROW_HEIGHT}`}
                            fill="none"
                            stroke={color}
                            strokeWidth={2}
                            opacity={0.8}
                        />
                    );
                })}

            {/* Commit dot */}
            {isSelected ? (
                <>
                    <circle cx={cx} cy={cy} r={DOT_R_HEAD + 1} fill="var(--bg-surface)" />
                    <foreignObject x={cx - 7} y={cy - 7} width={14} height={14}>
                        <CheckCircle
                            size={14}
                            weight="fill"
                            style={{ color: "var(--accent-green)" }}
                        />
                    </foreignObject>
                </>
            ) : isHead ? (
                <>
                    <circle cx={cx} cy={cy} r={DOT_R_HEAD} fill="var(--bg-surface)" stroke={GRAPH_COLORS[row.color % GRAPH_COLORS.length]} strokeWidth={2} />
                </>
            ) : row.isMerge ? (
                <>
                    <circle cx={cx} cy={cy} r={DOT_R + 1} fill="var(--bg-surface)" stroke={GRAPH_COLORS[row.color % GRAPH_COLORS.length]} strokeWidth={2} />
                </>
            ) : (
                <circle cx={cx} cy={cy} r={DOT_R} fill={GRAPH_COLORS[row.color % GRAPH_COLORS.length]} />
            )}
        </svg>
    );
}

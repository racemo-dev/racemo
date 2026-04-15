/**
 * Git commit graph lane computation for Fork-like visualization.
 *
 * Computes which column each commit occupies and what lines to draw
 * (vertical pass-through, merge curves, branch-off curves).
 */

import type { GitCommitEntry } from "../types/git";

/** Colors for graph lanes (Fork-like palette). */
export const GRAPH_COLORS = [
    "#4A9EFF", // blue
    "#FF6B6B", // coral
    "#50C878", // green
    "#FFB347", // orange
    "#9B59B6", // purple
    "#1ABC9C", // teal
    "#E91E63", // pink
    "#FF9800", // amber
    "#00BCD4", // cyan
    "#8BC34A", // light green
];

/** A single line segment in a graph row. */
export interface GraphLine {
    /** Source column (top of this row or commit column). */
    fromCol: number;
    /** Destination column (bottom of this row or commit column). */
    toCol: number;
    /** Color index into GRAPH_COLORS. */
    color: number;
    /** Whether this is a merge/branch line (diagonal) vs pass-through (vertical). */
    type: "pass" | "merge-down" | "branch-up";
}

/** Computed graph info for a single commit row. */
export interface GraphRow {
    /** Column index where the commit dot is placed. */
    col: number;
    /** Color index for this commit's dot. */
    color: number;
    /** Total number of active lanes at this row. */
    laneCount: number;
    /** Lines to draw in this row segment. */
    lines: GraphLine[];
    /** Whether this is a merge commit (2+ parents). */
    isMerge: boolean;
}

/**
 * Given a list of commits (in topological/date order from git log),
 * compute graph lane assignments for each commit.
 *
 * The algorithm maintains a set of "lanes" — each lane tracks which
 * commit hash it expects to see next. When a commit appears, it claims
 * its lane; its first parent replaces it in that lane; additional parents
 * (merge) get new lanes or reuse existing ones.
 */
export function computeGraphRows(commits: GitCommitEntry[]): GraphRow[] {
    // lanes[i] = { hash, color } — what hash lane i is waiting for
    const lanes: ({ hash: string; color: number } | null)[] = [];
    let nextColor = 0;
    const rows: GraphRow[] = [];

    const allocColor = () => {
        const c = nextColor;
        nextColor = (nextColor + 1) % GRAPH_COLORS.length;
        return c;
    };

    const findLane = (hash: string): number => {
        for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] && lanes[i]!.hash === hash) return i;
        }
        return -1;
    };

    const findEmptyLane = (): number => {
        for (let i = 0; i < lanes.length; i++) {
            if (!lanes[i]) return i;
        }
        return lanes.length;
    };

    for (const commit of commits) {
        const lines: GraphLine[] = [];

        // 1. Find all lanes that expect this commit
        const matchingLanes: number[] = [];
        for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] && lanes[i]!.hash === commit.hash) {
                matchingLanes.push(i);
            }
        }

        let col: number;
        let color: number;

        if (matchingLanes.length > 0) {
            // Use the leftmost matching lane as the commit's column
            col = matchingLanes[0];
            color = lanes[col]!.color;

            // Close all other matching lanes (they merge here)
            for (let i = 1; i < matchingLanes.length; i++) {
                const otherCol = matchingLanes[i];
                lines.push({
                    fromCol: otherCol,
                    toCol: col,
                    color: lanes[otherCol]!.color,
                    type: "merge-down",
                });
                lanes[otherCol] = null;
            }
        } else {
            // New branch — assign to first empty lane
            col = findEmptyLane();
            color = allocColor();
            if (col >= lanes.length) {
                lanes.push(null);
            }
        }

        // 2. Add pass-through lines for all OTHER active lanes
        for (let i = 0; i < lanes.length; i++) {
            if (lanes[i] && i !== col && !matchingLanes.includes(i)) {
                lines.push({
                    fromCol: i,
                    toCol: i,
                    color: lanes[i]!.color,
                    type: "pass",
                });
            }
        }

        // 3. Set up this lane for the first parent
        const isMerge = commit.parents.length > 1;

        if (commit.parents.length > 0) {
            const firstParent = commit.parents[0];
            lanes[col] = { hash: firstParent, color };

            // Pass-through line for the commit's own lane
            lines.push({
                fromCol: col,
                toCol: col,
                color,
                type: "pass",
            });
        } else {
            // Root commit — lane ends
            lanes[col] = null;
        }

        // 4. Handle additional parents (merge commits)
        for (let p = 1; p < commit.parents.length; p++) {
            const parentHash = commit.parents[p];
            const existingLane = findLane(parentHash);

            if (existingLane >= 0) {
                // Parent already has a lane — draw merge line to it
                lines.push({
                    fromCol: col,
                    toCol: existingLane,
                    color: lanes[existingLane]!.color,
                    type: "branch-up",
                });
            } else {
                // Allocate a new lane for this parent
                const newLane = findEmptyLane();
                const parentColor = allocColor();
                if (newLane >= lanes.length) {
                    lanes.push(null);
                }
                lanes[newLane] = { hash: parentHash, color: parentColor };
                lines.push({
                    fromCol: col,
                    toCol: newLane,
                    color: parentColor,
                    type: "branch-up",
                });
            }
        }

        // 5. Compact trailing nulls
        while (lanes.length > 0 && !lanes[lanes.length - 1]) {
            lanes.pop();
        }

        rows.push({
            col,
            color,
            laneCount: lanes.length,
            lines,
            isMerge,
        });
    }

    return rows;
}

/** Get the max lane count across all rows (for sizing the graph column). */
export function getMaxLanes(rows: GraphRow[]): number {
    let max = 1;
    for (const row of rows) {
        if (row.laneCount > max) max = row.laneCount;
    }
    return max;
}

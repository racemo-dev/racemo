export function TextBlock({ lines }: { lines: string[] }) {
  return (
    <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "20px" }}>
      {lines.map((l, i) => (
        <div key={i}>{l || "\u00A0"}</div>
      ))}
    </div>
  );
}

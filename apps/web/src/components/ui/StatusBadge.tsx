export type StatusTone = "ready" | "pending" | "warning" | "muted";

const glyphs: Record<StatusTone, string> = {
  ready: "■",
  pending: "□",
  warning: "▲",
  muted: "―",
};

interface StatusBadgeProps {
  children: string;
  tone?: StatusTone;
}

export function StatusBadge({ children, tone = "ready" }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <span aria-hidden="true">{glyphs[tone]}</span>
      <span>{children}</span>
    </span>
  );
}

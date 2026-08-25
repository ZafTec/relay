import type { ReactNode } from "react";

interface EmptyStateProps {
  label: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
}

export function EmptyState({ label, title, children, actions, aside }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <div className="empty-state__content">
        <p className="mono-label">{label}</p>
        <h2 id="empty-state-title">{title}</h2>
        <div className="empty-state__copy">{children}</div>
        {actions ? <div className="empty-state__actions">{actions}</div> : null}
      </div>
      {aside ? <aside className="empty-state__aside" aria-label="Connection details">{aside}</aside> : null}
    </section>
  );
}

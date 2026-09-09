import type { ReactNode } from "react";
import "./disclosure.css";

interface DisclosureProps {
  title: string;
  description?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** Native disclosure keeps hidden controls and their state mounted. */
export function Disclosure({ title, description, children, defaultOpen = false, className = "" }: DisclosureProps) {
  return <details className={`disclosure ${className}`} open={defaultOpen}>
    <summary>
      <span className="disclosure__label"><span className="disclosure__title">{title}</span>{description ? <span className="disclosure__description">{description}</span> : null}</span>
      <span className="disclosure__chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="disclosure__body">{children}</div>
  </details>;
}

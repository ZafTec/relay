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
export function Disclosure(
  { title, description, children, defaultOpen = false, className = "" }:
    DisclosureProps,
) {
  return (
    <details className={`disclosure ${className}`} open={defaultOpen}>
      <summary>
        <span className="disclosure__label">
          <span className="disclosure__title">{title}</span>
          {description
            ? <span className="disclosure__description">{description}</span>
            : null}
        </span>
        <svg
          className="disclosure__chevron"
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="disclosure__body">{children}</div>
    </details>
  );
}

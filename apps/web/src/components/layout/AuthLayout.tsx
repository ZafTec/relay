import type { ReactNode } from "react";
import { RelayBrand } from "../brand/RelayBrand";

interface AuthLayoutProps {
  children: ReactNode;
  compactMessage?: boolean;
}

export function AuthLayout({ children, compactMessage = false }: AuthLayoutProps) {
  return (
    <div className="auth-shell product-surface">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <section className="auth-shell__story" aria-labelledby="auth-story-title">
        <RelayBrand surface="product" />
        <div className="auth-shell__statement">
          <p className="auth-shell__story-title" id="auth-story-title">Call the tool.<br />Track the work.<br />Share the result.</p>
          {!compactMessage ? (
            <p>Curated, metered tools for AI agents. Every durable result leaves through a Relay-managed URL.</p>
          ) : null}
        </div>
        <p className="auth-shell__notation">RLY-01 / WORKSPACE-SCOPED / OAUTH ONLY</p>
      </section>
      <main className="auth-shell__main" id="main-content">
        {children}
      </main>
    </div>
  );
}

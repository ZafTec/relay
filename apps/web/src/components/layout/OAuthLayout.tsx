import type { ReactNode } from "react";
import { RelayBrand } from "../brand/RelayBrand";
import { LegalLinks } from "./LegalLinks";

interface OAuthLayoutProps {
  children: ReactNode;
}

export function OAuthLayout({ children }: OAuthLayoutProps) {
  return (
    <div className="oauth-shell product-surface">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="oauth-shell__header">
        <RelayBrand surface="product" />
        <span className="mono-label">Secure authorization</span>
      </header>
      <main className="oauth-shell__main" id="main-content">
        {children}
      </main>
      <footer className="oauth-shell__footer">
        <span>RLY-01 / MCP OAUTH</span>
        <span>Only approve clients you recognize.</span>
        <LegalLinks />
      </footer>
    </div>
  );
}

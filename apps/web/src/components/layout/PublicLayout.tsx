import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { RelayBrand } from "../brand/RelayBrand";
import { LinkButton } from "../ui/Button";

interface PublicLayoutProps {
  children: ReactNode;
}

export function PublicLayout({ children }: PublicLayoutProps) {
  return (
    <div className="public-surface public-page">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="public-header">
        <div className="public-header__inner">
          <RelayBrand />
          <nav className="public-nav" aria-label="Primary">
            <a className="public-nav__section-link" href="#platform">Platform</a>
            <a className="public-nav__section-link" href="#metering">Metering</a>
            <a className="public-nav__section-link" href="#availability">Availability</a>
            <LinkButton variant="outline" to="/sign-in">Sign in</LinkButton>
          </nav>
        </div>
      </header>
      {children}
      <footer className="public-footer product-surface">
        <div className="public-footer__inner">
          <div className="public-footer__brand">
            <RelayBrand surface="product" />
            <p>Metered tools and durable artifact URLs for AI agents.</p>
          </div>
          <nav className="public-footer__nav" aria-label="Footer">
            <a href="#platform">Platform</a>
            <a href="#metering">Metering</a>
            <Link to="/sign-in">Sign in</Link>
            <a href="https://zaftech.co" rel="noreferrer">ZafTech</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

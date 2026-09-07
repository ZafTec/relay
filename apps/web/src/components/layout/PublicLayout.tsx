import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
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
            <div className="public-nav__links">
              <NavLink className="public-nav__section-link" end to="/#platform">Platform</NavLink>
              <NavLink className="public-nav__section-link" to="/changelog">Changelog</NavLink>
              <NavLink className="public-nav__section-link" to="/docs">Docs</NavLink>
              <NavLink className="public-nav__section-link" to="/status">Status</NavLink>
            </div>
            <details className="public-nav__menu">
              <summary>Menu</summary>
              <div className="public-nav__menu-panel">
                <NavLink end to="/#platform">Platform</NavLink>
                <NavLink to="/changelog">Changelog</NavLink>
                <NavLink to="/docs">Docs</NavLink>
                <NavLink to="/status">Status</NavLink>
              </div>
            </details>
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
            <Link to="/#platform">Platform</Link>
            <Link to="/changelog">Changelog</Link>
            <Link to="/docs">Docs</Link>
            <Link to="/status">Status</Link>
            <Link to="/sign-in">Sign in</Link>
            <span>ZafTech</span>
          </nav>
        </div>
      </footer>
    </div>
  );
}

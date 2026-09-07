import { legalLinks } from "../../lib/legal";
import { openCookieSettings } from "../../lib/analytics-consent";
import "./legal-links.css";

export function LegalLinks() {
  return <nav className="legal-links" aria-label="ZafTech policies">
    <a href={legalLinks.terms}>Terms</a>
    <a href={legalLinks.privacy}>Privacy</a>
    <a href={legalLinks.cookies}>Cookies</a>
    <a href={legalLinks.acceptableUse}>Acceptable use</a>
    <a href={legalLinks.refunds}>Refunds</a>
    <button type="button" onClick={openCookieSettings}>Cookie settings</button>
  </nav>;
}

import { useEffect, useRef, useState } from "react";
import { CONSENT_CHANGED_EVENT, readAnalyticsChoice, saveAnalyticsChoice, type AnalyticsChoice } from "../../lib/analytics-consent";
import { legalLinks } from "../../lib/legal";
import { Button } from "../ui/Button";
import "./legal-links.css";

export function CookiePreferences({ configured = Boolean(import.meta.env.VITE_FARO_COLLECTOR_URL) }: { configured?: boolean }) {
  const [visible, setVisible] = useState(configured && readAnalyticsChoice() === null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const open = () => {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setVisible(true);
      requestAnimationFrame(() => heading.current?.focus());
    };
    const changed = () => setVisible(configured && readAnalyticsChoice() === null);
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key === "zaf_consent" || event.key === "zaf_consent_at") changed();
    };
    window.addEventListener("zaf:reopen-consent", open);
    window.addEventListener(CONSENT_CHANGED_EVENT, changed);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("zaf:reopen-consent", open);
      window.removeEventListener(CONSENT_CHANGED_EVENT, changed);
      window.removeEventListener("storage", storageChanged);
    };
  }, [configured]);
  function choose(choice: AnalyticsChoice) {
    saveAnalyticsChoice(choice);
    setVisible(false);
    previousFocus.current?.focus();
  }
  if (!visible) return null;
  return <section className="cookie-preferences product-surface" aria-labelledby="cookie-preferences-title">
    <h2 id="cookie-preferences-title" tabIndex={-1} ref={heading}>Your privacy choices</h2>
    <p>Essential storage keeps Relay working. With your permission, optional performance and error reports help us improve it. Prompts, files, and credentials are excluded. <a href={legalLinks.cookies}>Cookie policy</a></p>
    <div className="cookie-preferences__actions">
      <Button variant="outline" onClick={() => choose("denied")}>Essential only</Button>
      <Button variant="outline" onClick={() => choose("granted")}>Allow analytics</Button>
    </div>
    <p className="cookie-preferences__note">Your choice lasts 180 days on this browser. Change it anytime in Cookie settings.</p>
  </section>;
}

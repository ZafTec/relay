export type AnalyticsChoice = "granted" | "denied";
export const CONSENT_CHANGED_EVENT = "zaf:consent-changed";
export const CONSENT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
let memoryChoice: { choice: AnalyticsChoice; at: number } | null = null;

export function readAnalyticsChoice(): AnalyticsChoice | null {
  let choice: string | null;
  let at: number;
  try {
    choice = memoryChoice?.choice ?? window.localStorage.getItem("zaf_consent");
    at = memoryChoice?.at ?? Number(window.localStorage.getItem("zaf_consent_at"));
  } catch {
    choice = memoryChoice?.choice ?? null;
    at = memoryChoice?.at ?? 0;
  }
  const age = Date.now() - at;
  return (choice === "granted" || choice === "denied") && at > 0 && age >= 0 && age < CONSENT_MAX_AGE_MS ? choice : null;
}

export function saveAnalyticsChoice(choice: AnalyticsChoice): void {
  const at = Date.now();
  memoryChoice = { choice, at };
  try {
    window.localStorage.setItem("zaf_consent", choice);
    window.localStorage.setItem("zaf_consent_at", String(at));
    memoryChoice = null;
  } catch { /* Keep the choice for this page if browser storage is unavailable. */ }
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

export function openCookieSettings(): void {
  window.dispatchEvent(new Event("zaf:reopen-consent"));
}

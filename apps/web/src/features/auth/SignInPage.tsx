import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { safeReturnPath } from "../../auth/return-url";
import { AuthAdapterError, type AuthProviderName } from "../../auth/types";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { legalLinks } from "../../lib/legal";

function callbackError(code: string | null): { title: string; message: string } | null {
  if (!code) return null;
  const messages: Record<string, { title: string; message: string }> = {
    access_denied: {
      title: "Sign-in was cancelled",
      message: "The provider did not grant access. Nothing was created. Try again when you are ready.",
    },
    account_not_linked: {
      title: "Account is not linked",
      message: "Relay does not merge Google and GitHub identities by email. Use the provider originally linked to this account.",
    },
    unable_to_create_session: {
      title: "Session was not created",
      message: "Relay could not complete sign-in. Nothing was created. Try again.",
    },
  };
  return messages[code] ?? {
    title: "Sign-in did not complete",
    message: "Relay received an authentication error. Nothing was created. Try again or use the other provider.",
  };
}

export function SignInPage() {
  usePageMetadata("Sign in | Relay", "#141A16");
  const { adapter, session, refreshSession } = useAuth();
  const [searchParams] = useSearchParams();
  const [pendingProvider, setPendingProvider] = useState<AuthProviderName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const returnTo = safeReturnPath(searchParams.get("returnTo"));
  const error = callbackError(searchParams.get("error"));
  const expired = searchParams.get("reason") === "session-expired";
  const sessionUnavailable = session.status === "degraded";

  if (session.status === "authenticated") {
    return <Navigate to={returnTo} replace />;
  }

  async function startSignIn(provider: AuthProviderName) {
    setActionError(null);
    setPendingProvider(provider);
    try {
      await adapter.signIn(provider, returnTo);
      setPendingProvider(null);
    } catch (caught) {
      setPendingProvider(null);
      setActionError(caught instanceof AuthAdapterError
        ? `${provider === "google" ? "Google" : "GitHub"} sign-in did not complete. Nothing was created. Try again.`
        : "Relay could not start sign-in. Nothing was created. Try again.");
    }
  }

  return (
    <AuthLayout>
      <div className="sign-in-panel">
        <div>
          <p className="mono-label">OAuth only</p>
          <h1>Sign in to Relay</h1>
          <p className="sign-in-panel__intro">Use Google or GitHub. Relay does not offer password sign-in.</p>
        </div>

        {session.status === "loading" ? (
          <Skeleton label="Checking existing session" lines={2} />
        ) : (
          <>
            {session.status === "degraded" ? (
              <InlineNotice
                title="Session service unavailable"
                tone="error"
                action={
                  <Button variant="outline" onClick={() => void refreshSession()}>
                    Retry session check
                  </Button>
                }
              >
                <p>{session.message}</p>
              </InlineNotice>
            ) : null}
            {expired ? (
              <InlineNotice title="Session expired" tone="warning">
                <p>Sign in again to return to <code>{returnTo}</code>. Accepted background work keeps running.</p>
              </InlineNotice>
            ) : null}
            {error ? (
              <InlineNotice title={error.title} tone="error"><p>{error.message}</p></InlineNotice>
            ) : null}
            {actionError ? (
              <InlineNotice title="Sign-in failed" tone="error"><p>{actionError}</p></InlineNotice>
            ) : null}

            <div className="provider-actions" aria-label="Sign-in providers">
              <Button
                className="provider-button provider-button--google"
                variant="ink"
                pending={pendingProvider === "google"}
                pendingLabel="Opening Google"
                disabled={pendingProvider !== null || sessionUnavailable}
                onClick={() => void startSignIn("google")}
                endGlyph="→"
              >
                {sessionUnavailable ? "Google unavailable" : "Continue with Google"}
              </Button>
              <Button
                className="provider-button"
                variant="outline"
                pending={pendingProvider === "github"}
                pendingLabel="Opening GitHub"
                disabled={pendingProvider !== null || sessionUnavailable}
                onClick={() => void startSignIn("github")}
                endGlyph="→"
              >
                {sessionUnavailable ? "GitHub unavailable" : "Continue with GitHub"}
              </Button>
            </div>
          </>
        )}

        <div className="sign-in-panel__footnote">
          <p>Signing in creates or resumes your personal Relay workspace.</p>
          <p>By continuing, you agree to ZafTech’s <a href={legalLinks.terms}>Terms of Service</a> and <a href={legalLinks.acceptableUse}>Acceptable Use Policy</a>. Read the <a href={legalLinks.privacy}>Privacy Policy</a> and <a href={legalLinks.cookies}>Cookie Policy</a>.</p>
          <p className="mono-label">RLY-01 / OAuth only</p>
        </div>
      </div>
    </AuthLayout>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { signInPathFor } from "../../auth/return-url";
import { AuthAdapterError } from "../../auth/types";
import { RelayBrand } from "../../components/brand/RelayBrand";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  type AdminChangelogAdapter,
  httpAdminChangelogAdapter,
} from "../../lib/api/admin-changelog";
import {
  AdminChangelogProvider,
  type AdminChangelogContextValue,
} from "./AdminChangelogContext";
import { isAbortError } from "./model";

interface AdminChangelogRouteBoundaryProps {
  readonly adapter?: AdminChangelogAdapter;
}

type GateState =
  | { readonly kind: "loading" }
  | { readonly kind: "allowed"; readonly sessionId: string }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication-required" }
  | { readonly kind: "degraded"; readonly message: string };

function GateFrame({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className="admin-gate product-surface">
      <RelayBrand surface="product" />
      <div className="admin-gate__panel">{children}</div>
    </main>
  );
}

export function AdminChangelogRouteBoundary({
  adapter = httpAdminChangelogAdapter,
}: AdminChangelogRouteBoundaryProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { adapter: authAdapter, session, expireSession } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthenticationError, setReauthenticationError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const reauthenticationGenerationRef = useRef(0);
  const activeRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef(sessionId);
  activeSessionIdRef.current = sessionId;

  const reportAccessFailure = useCallback<AdminChangelogContextValue["reportAccessFailure"]>((
    failure,
    expectedSessionId,
  ) => {
    if (failure.kind === "auth-expired") {
      expireSession(expectedSessionId);
      return;
    }
    if (
      expectedSessionId === undefined
      || activeSessionIdRef.current !== expectedSessionId
    ) return;

    requestGenerationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ kind: failure.kind });
  }, [expireSession]);

  useEffect(() => {
    if (sessionId === undefined) return;
    const expectedSessionId = sessionId;
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setState({ kind: "loading" });
    setReauthenticating(false);
    setReauthenticationError(null);

    void adapter.list({ limit: 1 }, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(expectedSessionId);
        return;
      }
      if (
        controller.signal.aborted
        || generation !== requestGenerationRef.current
        || activeSessionIdRef.current !== expectedSessionId
      ) return;

      if (result.kind === "ok") {
        setState({ kind: "allowed", sessionId: expectedSessionId });
      } else if (result.kind === "reauthentication-required") {
        setState({ kind: "reauthentication-required" });
      } else if (result.kind === "denied" || result.kind === "not-found") {
        setState({ kind: "denied" });
      } else {
        setState({ kind: "degraded", message: result.message });
      }
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || controller.signal.aborted
        || generation !== requestGenerationRef.current
        || activeSessionIdRef.current !== expectedSessionId
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not confirm admin changelog access. No admin data was shown.",
      });
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
    });

    return () => controller.abort();
  }, [adapter, expireSession, retryGeneration, sessionId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestGenerationRef.current += 1;
      reauthenticationGenerationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  async function restartAuthentication() {
    if (reauthenticating) return;
    const generation = ++reauthenticationGenerationRef.current;
    const expectedSessionId = sessionId;
    const returnPath = `${location.pathname}${location.search}${location.hash}`;
    setReauthenticationError(null);
    setReauthenticating(true);
    try {
      await authAdapter.signOut();
      if (
        !activeRef.current
        || generation !== reauthenticationGenerationRef.current
        || activeSessionIdRef.current !== expectedSessionId
      ) return;
      expireSession(expectedSessionId);
      navigate(signInPathFor(returnPath, "session-expired"), { replace: true });
    } catch (error) {
      if (!activeRef.current || generation !== reauthenticationGenerationRef.current) {
        return;
      }
      setReauthenticationError(error instanceof AuthAdapterError
        ? "Relay could not end the current session. Try again."
        : "Relay could not restart authentication. The current session was not changed.");
      setReauthenticating(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <GateFrame>
        <p className="mono-label">Platform access</p>
        <h1>Checking admin access</h1>
        <Skeleton label="Checking admin changelog access" lines={2} />
      </GateFrame>
    );
  }

  if (state.kind === "denied") {
    return (
      <GateFrame>
        <p className="mono-label">Platform access</p>
        <h1>Admin access unavailable</h1>
        <InlineNotice title="Access denied" tone="error">
          <p>This session cannot open the platform changelog. No admin changelog data was shown.</p>
        </InlineNotice>
        <LinkButton variant="outline" to="/dashboard">Back to workspace</LinkButton>
      </GateFrame>
    );
  }

  if (state.kind === "reauthentication-required") {
    return (
      <GateFrame>
        <p className="mono-label">Platform access</p>
        <h1>Reauthentication required</h1>
        <InlineNotice title="Confirm this session" tone="warning">
          <p>Sign out and sign in again before opening the platform changelog.</p>
        </InlineNotice>
        {reauthenticationError ? (
          <InlineNotice title="Reauthentication not started" tone="error">
            <p>{reauthenticationError}</p>
          </InlineNotice>
        ) : null}
        <div className="admin-inline-actions">
          <Button
            pending={reauthenticating}
            pendingLabel="Signing out"
            onClick={() => void restartAuthentication()}
          >
            Sign out and continue
          </Button>
          <LinkButton variant="outline" to="/dashboard">Back to workspace</LinkButton>
        </div>
      </GateFrame>
    );
  }

  if (state.kind === "degraded") {
    return (
      <GateFrame>
        <p className="mono-label">Platform access</p>
        <h1>Admin access check unavailable</h1>
        <InlineNotice
          title="Access not confirmed"
          tone="error"
          action={<Button variant="outline" onClick={() => setRetryGeneration((value) => value + 1)}>Try again</Button>}
        >
          <p>{state.message}</p>
        </InlineNotice>
        <LinkButton variant="quiet" to="/dashboard">Back to workspace</LinkButton>
      </GateFrame>
    );
  }

  if (sessionId === undefined || state.sessionId !== sessionId) return null;

  return (
    <AdminChangelogProvider
      adapter={adapter}
      reportAccessFailure={reportAccessFailure}
    >
      <Outlet />
    </AdminChangelogProvider>
  );
}

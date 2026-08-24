import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { betterAuthAdapter } from "./auth-adapter";
import { AuthAdapterError, type AuthAdapter, type RelayIdentity, type RelayWorkspace } from "./types";

const AUTH_MARKER = "relay.authenticated";
const MAX_TIMEOUT_DELAY_MS = 2_147_000_000;

export type SessionState =
  | { status: "loading" }
  | { status: "authenticated"; identity: RelayIdentity }
  | { status: "anonymous"; reason: "auth-required" | "session-expired" }
  | { status: "degraded"; message: string };

export type WorkspaceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; workspace: RelayWorkspace }
  | { status: "empty" }
  | { status: "degraded"; message: string };

interface AuthContextValue {
  adapter: AuthAdapter;
  session: SessionState;
  workspace: WorkspaceState;
  refreshSession(): Promise<void>;
  refreshWorkspace(): Promise<void>;
  signOut(): Promise<void>;
  expireSession(expectedSessionId?: string): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readAuthenticatedMarker(): boolean {
  try {
    return sessionStorage.getItem(AUTH_MARKER) === "true";
  } catch {
    return false;
  }
}

function writeAuthenticatedMarker(authenticated: boolean): void {
  try {
    if (authenticated) sessionStorage.setItem(AUTH_MARKER, "true");
    else sessionStorage.removeItem(AUTH_MARKER);
  } catch {
    // Session storage can be unavailable in hardened browser contexts.
  }
}

function sessionFailureMessage(error: unknown): string {
  if (error instanceof AuthAdapterError && error.status === 401) {
    return "The session is no longer active.";
  }
  return "Relay could not verify the session. Check the connection and try again.";
}

function workspaceFailureMessage(): string {
  return "Relay could not load the active workspace. No workspace was changed.";
}

const WORKSPACE_CONTEXT_MISMATCH =
  "The active workspace does not match the current session. Refresh the session and try again.";

interface AuthProviderProps {
  children: ReactNode;
  adapter?: AuthAdapter;
}

export function AuthProvider({ children, adapter = betterAuthAdapter }: AuthProviderProps) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [workspace, setWorkspace] = useState<WorkspaceState>({ status: "idle" });
  const sessionRequest = useRef(0);
  const workspaceRequest = useRef(0);
  const activeIdentity = useRef<RelayIdentity | null>(null);

  const transitionToAnonymous = useCallback((reason: "auth-required" | "session-expired") => {
    sessionRequest.current += 1;
    workspaceRequest.current += 1;
    activeIdentity.current = null;
    writeAuthenticatedMarker(false);
    setWorkspace({ status: "idle" });
    setSession({ status: "anonymous", reason });
  }, []);

  const loadWorkspace = useCallback(async (identity = activeIdentity.current) => {
    if (!identity) {
      workspaceRequest.current += 1;
      setWorkspace({ status: "idle" });
      return;
    }

    const request = ++workspaceRequest.current;
    const expectedSessionId = identity.session.id;
    const expectedWorkspaceId = identity.session.activeWorkspaceId;
    setWorkspace({ status: "loading" });
    try {
      const currentWorkspace = await adapter.getActiveWorkspace();
      if (
        request !== workspaceRequest.current
        || activeIdentity.current?.session.id !== expectedSessionId
      ) return;

      if (currentWorkspace === null) {
        setWorkspace(expectedWorkspaceId === null
          ? { status: "empty" }
          : { status: "degraded", message: WORKSPACE_CONTEXT_MISMATCH });
        return;
      }

      if (expectedWorkspaceId === null || currentWorkspace.id !== expectedWorkspaceId) {
        setWorkspace({ status: "degraded", message: WORKSPACE_CONTEXT_MISMATCH });
        return;
      }

      setWorkspace({ status: "ready", workspace: currentWorkspace });
    } catch (error) {
      if (request !== workspaceRequest.current) return;
      if (error instanceof AuthAdapterError && error.status === 401) {
        transitionToAnonymous("session-expired");
        return;
      }
      setWorkspace({ status: "degraded", message: workspaceFailureMessage() });
    }
  }, [adapter, transitionToAnonymous]);

  const refreshSession = useCallback(async () => {
    const request = ++sessionRequest.current;
    workspaceRequest.current += 1;
    activeIdentity.current = null;
    setWorkspace({ status: "idle" });
    setSession({ status: "loading" });
    try {
      const identity = await adapter.getSession();
      if (request !== sessionRequest.current) return;
      if (!identity) {
        const expired = readAuthenticatedMarker();
        transitionToAnonymous(expired ? "session-expired" : "auth-required");
        return;
      }

      activeIdentity.current = identity;
      writeAuthenticatedMarker(true);
      setSession({ status: "authenticated", identity });
      void loadWorkspace(identity);
    } catch (error) {
      if (request !== sessionRequest.current) return;
      if (error instanceof AuthAdapterError && error.status === 401) {
        transitionToAnonymous("session-expired");
        return;
      }
      activeIdentity.current = null;
      workspaceRequest.current += 1;
      setSession({ status: "degraded", message: sessionFailureMessage(error) });
      setWorkspace({ status: "idle" });
    }
  }, [adapter, loadWorkspace, transitionToAnonymous]);

  const refreshWorkspace = useCallback(async () => {
    await loadWorkspace();
  }, [loadWorkspace]);

  const signOut = useCallback(async () => {
    await adapter.signOut();
    transitionToAnonymous("auth-required");
  }, [adapter, transitionToAnonymous]);

  const expireSession = useCallback((expectedSessionId?: string) => {
    if (
      expectedSessionId !== undefined
      && activeIdentity.current?.session.id !== expectedSessionId
    ) return;
    transitionToAnonymous("session-expired");
  }, [transitionToAnonymous]);

  useEffect(() => {
    void refreshSession();
    return () => {
      sessionRequest.current += 1;
      workspaceRequest.current += 1;
      activeIdentity.current = null;
    };
  }, [refreshSession]);

  const sessionExpiresAt = session.status === "authenticated"
    ? session.identity.session.expiresAt
    : null;
  useEffect(() => {
    if (!(sessionExpiresAt instanceof Date) || Number.isNaN(sessionExpiresAt.valueOf())) {
      return;
    }

    let timer: number | undefined;
    const scheduleExpiry = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      const remaining = sessionExpiresAt.getTime() - Date.now();
      if (remaining <= 0) {
        expireSession();
        return;
      }
      timer = window.setTimeout(scheduleExpiry, Math.min(remaining, MAX_TIMEOUT_DELAY_MS));
    };
    const checkVisibleSession = () => {
      if (document.visibilityState === "visible") scheduleExpiry();
    };

    scheduleExpiry();
    document.addEventListener("visibilitychange", checkVisibleSession);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkVisibleSession);
    };
  }, [expireSession, sessionExpiresAt]);

  const value = useMemo<AuthContextValue>(() => ({
    adapter,
    session,
    workspace,
    refreshSession,
    refreshWorkspace,
    signOut,
    expireSession,
  }), [adapter, expireSession, refreshSession, refreshWorkspace, session, signOut, workspace]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}

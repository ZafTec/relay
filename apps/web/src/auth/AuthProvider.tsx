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
  expireSession(): void;
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

function workspaceFailureMessage(error: unknown): string {
  if (error instanceof AuthAdapterError && error.status === 401) {
    return "The session expired while Relay was loading the workspace.";
  }
  return "Relay could not load the active workspace. No workspace was changed.";
}

interface AuthProviderProps {
  children: ReactNode;
  adapter?: AuthAdapter;
}

export function AuthProvider({ children, adapter = betterAuthAdapter }: AuthProviderProps) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [workspace, setWorkspace] = useState<WorkspaceState>({ status: "idle" });
  const sessionRequest = useRef(0);
  const workspaceRequest = useRef(0);

  const loadWorkspace = useCallback(async () => {
    const request = ++workspaceRequest.current;
    setWorkspace({ status: "loading" });
    try {
      const activeWorkspace = await adapter.getActiveWorkspace();
      if (request !== workspaceRequest.current) return;
      setWorkspace(activeWorkspace
        ? { status: "ready", workspace: activeWorkspace }
        : { status: "empty" });
    } catch (error) {
      if (request !== workspaceRequest.current) return;
      setWorkspace({ status: "degraded", message: workspaceFailureMessage(error) });
    }
  }, [adapter]);

  const refreshSession = useCallback(async () => {
    const request = ++sessionRequest.current;
    setSession({ status: "loading" });
    try {
      const identity = await adapter.getSession();
      if (request !== sessionRequest.current) return;
      if (!identity) {
        const expired = readAuthenticatedMarker();
        writeAuthenticatedMarker(false);
        setWorkspace({ status: "idle" });
        setSession({
          status: "anonymous",
          reason: expired ? "session-expired" : "auth-required",
        });
        return;
      }

      writeAuthenticatedMarker(true);
      setSession({ status: "authenticated", identity });
      void loadWorkspace();
    } catch (error) {
      if (request !== sessionRequest.current) return;
      if (error instanceof AuthAdapterError && error.status === 401) {
        writeAuthenticatedMarker(false);
        setWorkspace({ status: "idle" });
        setSession({ status: "anonymous", reason: "session-expired" });
        return;
      }
      setSession({ status: "degraded", message: sessionFailureMessage(error) });
      setWorkspace({ status: "idle" });
    }
  }, [adapter, loadWorkspace]);

  const signOut = useCallback(async () => {
    await adapter.signOut();
    writeAuthenticatedMarker(false);
    setWorkspace({ status: "idle" });
    setSession({ status: "anonymous", reason: "auth-required" });
  }, [adapter]);

  const expireSession = useCallback(() => {
    writeAuthenticatedMarker(false);
    setWorkspace({ status: "idle" });
    setSession({ status: "anonymous", reason: "session-expired" });
  }, []);

  useEffect(() => {
    void refreshSession();
    return () => {
      sessionRequest.current += 1;
      workspaceRequest.current += 1;
    };
  }, [refreshSession]);

  const value = useMemo<AuthContextValue>(() => ({
    adapter,
    session,
    workspace,
    refreshSession,
    refreshWorkspace: loadWorkspace,
    signOut,
    expireSession,
  }), [adapter, expireSession, loadWorkspace, refreshSession, session, signOut, workspace]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}

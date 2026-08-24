import { Navigate, Outlet, useLocation } from "react-router-dom";
import { DegradedPageState, LoadingPageState } from "../components/ui/PageState";
import { useAuth } from "./AuthProvider";
import { signInPathFor } from "./return-url";

export function ProtectedRoute() {
  const location = useLocation();
  const { session, refreshSession } = useAuth();

  if (session.status === "loading") {
    return <LoadingPageState label="Checking Relay session" />;
  }

  if (session.status === "degraded") {
    return (
      <DegradedPageState
        title="Session check unavailable"
        message={session.message}
        onRetry={() => void refreshSession()}
      />
    );
  }

  if (session.status === "anonymous") {
    const returnPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={signInPathFor(returnPath, session.reason)} replace />;
  }

  return <Outlet />;
}

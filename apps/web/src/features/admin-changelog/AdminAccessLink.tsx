import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { checkAdminAccess, type CheckAdminAccess } from "../../lib/api/admin-access";
import { isAbortError } from "./model";

interface AdminAccessLinkProps {
  readonly checkAccess?: CheckAdminAccess;
  readonly className?: string;
}

export function AdminAccessLink({
  checkAccess = checkAdminAccess,
  className,
}: AdminAccessLinkProps) {
  const { session, expireSession } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const sessionIdRef = useRef(sessionId);
  const generationRef = useRef(0);
  const [confirmedSessionId, setConfirmedSessionId] = useState<string | null>(null);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (sessionId === undefined) {
      setConfirmedSessionId(null);
      return;
    }
    const expectedSessionId = sessionId;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setConfirmedSessionId(null);

    void checkAccess(controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(expectedSessionId);
        return;
      }
      if (
        controller.signal.aborted
        || generation !== generationRef.current
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setConfirmedSessionId(result.kind === "ok" ? expectedSessionId : null);
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || controller.signal.aborted
        || generation !== generationRef.current
      ) return;
      setConfirmedSessionId(null);
    });

    return () => controller.abort();
  }, [checkAccess, expireSession, sessionId]);

  useEffect(() => () => {
    generationRef.current += 1;
  }, []);

  if (sessionId === undefined || confirmedSessionId !== sessionId) return null;
  return (
    <Link
      className={["admin-access-link", className].filter(Boolean).join(" ")}
      to="/admin/allowances"
    >
      Platform admin
    </Link>
  );
}

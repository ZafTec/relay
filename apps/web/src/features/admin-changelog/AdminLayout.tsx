import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { AuthAdapterError } from "../../auth/types";
import { RelayBrand } from "../../components/brand/RelayBrand";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "R";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function AdminNavigation({ mobile = false }: { readonly mobile?: boolean }) {
  return (
    <nav
      className={mobile ? "admin-tabs" : "admin-nav"}
      aria-label="Superadmin sections"
    >
      <NavLink
        className={({ isActive }) => `admin-nav__item${isActive ? " is-active" : ""}`}
        to="/admin/changelog"
      >
        Changelog
      </NavLink>
      <NavLink
        className={({ isActive }) => `admin-nav__item${isActive ? " is-active" : ""}`}
        to="/admin/capacity"
      >
        Capacity
      </NavLink>
      <NavLink
        className={({ isActive }) => `admin-nav__item${isActive ? " is-active" : ""}`}
        to="/admin/allowances"
      >
        Allowances
      </NavLink>
      <NavLink className={({ isActive }) => `admin-nav__item${isActive ? " is-active" : ""}`} to="/admin/superadmins">Superadmins</NavLink>
      <NavLink className={({ isActive }) => `admin-nav__item${isActive ? " is-active" : ""}`} to="/admin/status">Service status</NavLink>
    </nav>
  );
}

export function AdminLayout() {
  const navigate = useNavigate();
  const allowanceRoute = useLocation().pathname.startsWith("/admin/allowances");
  const { session, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const actionGenerationRef = useRef(0);
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      actionGenerationRef.current += 1;
    };
  }, []);

  if (session.status !== "authenticated") return null;

  const identity = session.identity;
  const userInitials = initials(identity.user.name);

  async function handleSignOut() {
    const expectedSessionId = identity.session.id;
    const generation = ++actionGenerationRef.current;
    setSignOutError(null);
    setSigningOut(true);
    try {
      await signOut();
      if (
        activeRef.current
        && generation === actionGenerationRef.current
        && sessionIdRef.current === expectedSessionId
      ) navigate("/", { replace: true });
    } catch (error) {
      if (
        !activeRef.current
        || generation !== actionGenerationRef.current
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setSignOutError(error instanceof AuthAdapterError
        ? "Relay could not end the session. Try again."
        : "Relay could not end the session. No account data was changed.");
      setSigningOut(false);
    }
  }

  return (
    <div className="admin-shell product-surface">
      <a className="skip-link" href="#admin-main-content">Skip to content</a>
      <aside className="admin-rail" aria-label="Platform navigation">
        <div className="admin-rail__brand">
          <RelayBrand surface="product" compact showParent={false} />
        </div>
        <div className="admin-scope">
          <span>Scope</span>
          <strong>Platform</strong>
          <p>{allowanceRoute ? "Superadmin controls for workspace access and usage." : "Superadmin context. No workspace is selected."}</p>
        </div>
        <AdminNavigation />
        <Link className="admin-back-link" to="/dashboard">Back to workspace</Link>
        <div className="admin-session">
          <Link
            className="session-profile-link"
            to="/profile"
            aria-label={`Open profile for ${identity.user.name}`}
          >
            <span className="session-avatar" aria-hidden="true">{userInitials}</span>
            <span className="session-copy">
              <strong>{identity.user.name}</strong>
              <span>{identity.user.email}</span>
            </span>
          </Link>
          <Button
            className="session-sign-out"
            variant="quiet"
            pending={signingOut}
            pendingLabel="Signing out"
            onClick={() => void handleSignOut()}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-mobile-header">
          <RelayBrand surface="product" compact showParent={false} />
          <div className="admin-mobile-header__actions">
            <Link className="admin-mobile-link" to="/dashboard">Workspace</Link>
            <Link className="admin-mobile-link" to="/profile">Profile</Link>
            <Button
              variant="quiet"
              pending={signingOut}
              pendingLabel="Signing out"
              onClick={() => void handleSignOut()}
            >
              Sign out
            </Button>
          </div>
        </header>
        <div className="admin-mobile-scope">
          <span>Platform scope</span>
          <strong>{allowanceRoute ? "Workspace allowances" : "No workspace selected"}</strong>
        </div>
        <AdminNavigation mobile />
        {signOutError ? (
          <div className="admin-global-notice">
            <InlineNotice title="Sign-out failed" tone="error"><p>{signOutError}</p></InlineNotice>
          </div>
        ) : null}
        <main className="admin-content" id="admin-main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

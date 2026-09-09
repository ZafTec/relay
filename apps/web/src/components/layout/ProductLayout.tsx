import { lazy, type ReactNode, Suspense, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { AuthAdapterError } from "../../auth/types";
import { RelayBrand } from "../brand/RelayBrand";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineNotice } from "../ui/InlineNotice";

const AdminAccessLink = lazy(() =>
  import("../../features/admin-changelog/AdminAccessLink").then((module) => ({
    default: module.AdminAccessLink,
  }))
);

const sections = [
  { label: "Tools", to: "/dashboard/tools" },
  { label: "Runs", to: "/dashboard/runs" },
  { label: "Artifacts", to: "/dashboard/artifacts" },
  { label: "Usage", to: "/dashboard/usage" },
  { label: "OAuth clients", to: "/dashboard/oauth-clients" },
  { label: "Settings", to: "/dashboard/settings" },
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "R";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function WorkspaceLabel() {
  const { workspace } = useAuth();

  if (workspace.status === "ready") {
    return (
      <div className="workspace-label">
        <span className="workspace-label__eyebrow">Workspace</span>
        <strong>{workspace.workspace.name}</strong>
        <span className="workspace-label__id">@{workspace.workspace.slug}</span>
        <Link to="/dashboard/settings#workspaces" className="workspace-label__manage">Switch or create workspace</Link>
      </div>
    );
  }
  if (workspace.status === "loading" || workspace.status === "idle") {
    return (
      <div className="workspace-label" role="status">
        <span className="workspace-label__eyebrow">Workspace</span>
        <strong>Loading workspace</strong>
      </div>
    );
  }
  if (workspace.status === "empty") {
    return (
      <div className="workspace-label">
        <span className="workspace-label__eyebrow">Workspace</span>
        <strong>No active workspace</strong>
      </div>
    );
  }
  return (
    <div className="workspace-label">
      <span className="workspace-label__eyebrow">Workspace</span>
      <strong>Workspace unavailable</strong>
    </div>
  );
}

function SectionNavigation({
  mobile = false,
  children,
}: {
  readonly mobile?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <nav className={mobile ? "product-tabs" : "product-nav"} aria-label="Sections">
      <NavLink
        className={({ isActive }) => `product-nav__item${isActive ? " is-active" : ""}`}
        end
        to="/dashboard"
      >
        Overview
      </NavLink>
      {sections.map((section) => (
        <NavLink
          className={({ isActive }) => `product-nav__item${isActive ? " is-active" : ""}`}
          key={section.label}
          to={section.to}
        >
          {section.label}
        </NavLink>
      ))}
      {children}
    </nav>
  );
}

export function ProductLayout() {
  const navigate = useNavigate();
  const { session, workspace, signOut, refreshWorkspace } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  if (session.status !== "authenticated") return null;

  const userInitials = initials(session.identity.user.name);

  async function handleSignOut() {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await signOut();
      navigate("/", { replace: true });
    } catch (error) {
      setSignOutError(error instanceof AuthAdapterError
        ? "Relay could not end the session. Try again."
        : "Relay could not end the session. No account data was changed.");
      setSigningOut(false);
      setConfirmingSignOut(false);
    }
  }

  return (
    <div className="product-shell product-surface">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="product-rail" aria-label="Workspace navigation">
        <div className="product-rail__brand"><RelayBrand surface="product" compact showParent={false} /></div>
        <div className="product-rail__workspace"><WorkspaceLabel /></div>
        <SectionNavigation>
          <Suspense fallback={null}>
            <AdminAccessLink className="product-nav__item" />
          </Suspense>
        </SectionNavigation>
        <div className="product-rail__session">
          <Link
            className="session-profile-link"
            to="/profile"
            aria-label={`Open profile for ${session.identity.user.name}`}
          >
            <span className="session-avatar" aria-hidden="true">{userInitials}</span>
            <span className="session-copy">
              <strong>{session.identity.user.name}</strong>
              <span>{session.identity.user.email}</span>
            </span>
          </Link>
          <Button
            className="session-sign-out"
            variant="quiet"
            pending={signingOut}
            pendingLabel="Signing out"
            onClick={() => setConfirmingSignOut(true)}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <div className="product-main">
        <header className="product-mobile-header">
          <RelayBrand surface="product" compact showParent={false} />
          <div className="product-mobile-header__actions">
            <Link className="product-mobile-profile" to="/profile">Profile</Link>
            <Button
              variant="quiet"
              pending={signingOut}
              pendingLabel="Signing out"
              onClick={() => setConfirmingSignOut(true)}
            >
              Sign out
            </Button>
          </div>
        </header>
        <div className="product-mobile-workspace"><WorkspaceLabel /></div>
        <SectionNavigation mobile>
          <Suspense fallback={null}>
            <AdminAccessLink className="product-nav__item" />
          </Suspense>
        </SectionNavigation>
        {workspace.status === "degraded" ? (
          <div className="product-global-notice">
            <InlineNotice
              title="Workspace context unavailable"
              tone="error"
              action={<Button variant="outline" onClick={() => void refreshWorkspace()}>Retry</Button>}
            >
              <p>{workspace.message}</p>
            </InlineNotice>
          </div>
        ) : null}
        {signOutError ? (
          <div className="product-global-notice">
            <InlineNotice title="Sign-out failed" tone="error"><p>{signOutError}</p></InlineNotice>
          </div>
        ) : null}
        <main className="product-content" id="main-content" tabIndex={0}>
          <Outlet />
        </main>
      </div>

      {confirmingSignOut ? (
        <ConfirmDialog
          title="Sign out of Relay?"
          description="You'll need to sign in again with Google or GitHub to continue."
          confirmLabel="Sign out"
          confirmPendingLabel="Signing out"
          pending={signingOut}
          onConfirm={() => void handleSignOut()}
          onCancel={() => setConfirmingSignOut(false)}
        />
      ) : null}
    </div>
  );
}

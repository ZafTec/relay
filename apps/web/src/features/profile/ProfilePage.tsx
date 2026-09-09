import { useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth, type WorkspaceState } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import "./profile.css";
import { ProfilePhotoEditor } from "./ProfilePhotoEditor";

const sessionExpiryFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "R";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

interface ProfileAvatarProps {
  image: string | null;
  initials: string;
  name: string;
}

function ProfileAvatar(
  { image, initials: fallbackInitials, name }: ProfileAvatarProps,
) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showsImage = Boolean(image && image !== failedSource);
  const label = showsImage
    ? `Profile image for ${name}`
    : `Profile initials ${fallbackInitials} for ${name}`;

  return (
    <span className="profile-avatar" role="img" aria-label={label}>
      {showsImage
        ? (
          <img
            src={image ?? undefined}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailedSource(image)}
          />
        )
        : <span aria-hidden="true">{fallbackInitials}</span>}
    </span>
  );
}

function sessionExpiry(
  expiresAt: Date | null,
): { dateTime: string; label: string } | null {
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.valueOf())) {
    return null;
  }
  return {
    dateTime: expiresAt.toISOString(),
    label: sessionExpiryFormatter.format(expiresAt),
  };
}

interface WorkspacePanelProps {
  state: WorkspaceState;
  onRetry: () => void;
}

function WorkspacePanel({ state, onRetry }: WorkspacePanelProps) {
  const loading = state.status === "idle" || state.status === "loading";
  const status = state.status === "ready"
    ? <StatusBadge>Current</StatusBadge>
    : state.status === "degraded"
    ? <StatusBadge tone="warning">Unavailable</StatusBadge>
    : state.status === "empty"
    ? <StatusBadge tone="muted">None</StatusBadge>
    : <StatusBadge tone="pending">Loading</StatusBadge>;

  return (
    <section
      className="profile-panel"
      aria-labelledby="profile-workspace-title"
      aria-busy={loading || undefined}
    >
      <header className="profile-panel__header">
        <h2 id="profile-workspace-title">Active workspace</h2>
        {status}
      </header>
      <div className="profile-panel__body">
        {state.status === "ready"
          ? (
            <dl className="profile-facts">
              <div>
                <dt>Name</dt>
                <dd>{state.workspace.name}</dd>
              </div>
              <div>
                <dt>Slug</dt>
                <dd>
                  <code>{state.workspace.slug}</code>
                </dd>
              </div>
              <div>
                <dt>Workspace ID</dt>
                <dd>
                  <code>{state.workspace.id}</code>
                </dd>
              </div>
            </dl>
          )
          : null}

        {loading
          ? <Skeleton label="Loading active workspace" lines={2} />
          : null}

        {state.status === "empty"
          ? (
            <p className="profile-panel__empty">
              No active workspace is attached to this session.
            </p>
          )
          : null}

        {state.status === "degraded"
          ? (
            <InlineNotice
              title="Active workspace unavailable"
              tone="error"
              action={
                <Button variant="outline" onClick={onRetry}>
                  Retry active workspace
                </Button>
              }
            >
              <p>{state.message}</p>
            </InlineNotice>
          )
          : null}
      </div>
    </section>
  );
}

export function ProfilePage() {
  usePageMetadata("Profile | Relay", "#141A16");
  const { session, workspace, refreshWorkspace } = useAuth();

  if (session.status !== "authenticated") return null;

  const { user } = session.identity;
  const displayName = user.name.trim() || "Name not provided";
  const displayEmail = user.email.trim() || "Email not provided";
  const expiry = sessionExpiry(session.identity.session.expiresAt);

  return (
    <div className="profile-page product-surface">
      <a className="skip-link" href="#profile-content">
        Skip to profile details
      </a>

      <header className="profile-page__header">
        <Link className="profile-page__back" to="/dashboard">
          Back to dashboard
        </Link>
        <span className="profile-page__divider" aria-hidden="true" />
        <h1>Profile</h1>
        <span className="profile-page__scope">Account scope</span>
      </header>

      <main className="profile-page__main" id="profile-content">
        <section
          className="profile-identity"
          aria-labelledby="profile-identity-title"
        >
          <ProfileAvatar
            image={user.image}
            initials={initials(user.name)}
            name={displayName}
          />
          <div className="profile-identity__content">
            <h2 id="profile-identity-title">{displayName}</h2>
            <dl className="profile-identity__facts">
              <div>
                <dt>Email</dt>
                <dd>{displayEmail}</dd>
              </div>
              <div>
                <dt>Profile source</dt>
                <dd>OAuth provider</dd>
              </div>
            </dl>
            <p className="profile-identity__note">
              Your name and email come from the account you use to sign in.
              Choose your own profile photo below.
            </p>
          </div>
        </section>

        <ProfilePhotoEditor image={user.image} />
        <div className="profile-ledger">
          <section
            className="profile-panel"
            aria-labelledby="profile-session-title"
          >
            <header className="profile-panel__header">
              <h2 id="profile-session-title">Current session</h2>
              <StatusBadge>Authenticated</StatusBadge>
            </header>
            <div className="profile-panel__body">
              <dl className="profile-facts">
                <div>
                  <dt>Status</dt>
                  <dd>Active</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>
                    {expiry
                      ? (
                        <>
                          <time dateTime={expiry.dateTime}>{expiry.label}</time>
                          <span className="profile-facts__caption">
                            Your local time
                          </span>
                        </>
                      )
                      : (
                        <span className="profile-facts__muted">
                          Not provided by this session
                        </span>
                      )}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <WorkspacePanel
            state={workspace}
            onRetry={() => void refreshWorkspace()}
          />
        </div>

        <section
          className="profile-password"
          aria-labelledby="profile-password-title"
        >
          <h2 id="profile-password-title">No Relay password</h2>
          <p>
            Relay uses OAuth sign-in and does not store a password for this
            account. Manage sign-in credentials with your OAuth provider.
          </p>
        </section>
      </main>
    </div>
  );
}

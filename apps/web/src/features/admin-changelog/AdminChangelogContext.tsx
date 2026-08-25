import { createContext, type ReactNode, useContext, useMemo } from "react";
import type {
  AdminChangelogAccessFailure,
  AdminChangelogAdapter,
} from "../../lib/api/admin-changelog";

type BoundaryAccessFailure = Exclude<AdminChangelogAccessFailure, { readonly kind: "not-found" }>;

export interface AdminChangelogContextValue {
  readonly adapter: AdminChangelogAdapter;
  reportAccessFailure(
    failure: BoundaryAccessFailure,
    expectedSessionId: string | undefined,
  ): void;
}

const AdminChangelogContext = createContext<AdminChangelogContextValue | null>(null);

interface AdminChangelogProviderProps {
  readonly adapter: AdminChangelogAdapter;
  readonly reportAccessFailure: AdminChangelogContextValue["reportAccessFailure"];
  readonly children: ReactNode;
}

export function AdminChangelogProvider({
  adapter,
  reportAccessFailure,
  children,
}: AdminChangelogProviderProps) {
  const value = useMemo<AdminChangelogContextValue>(() => ({
    adapter,
    reportAccessFailure,
  }), [adapter, reportAccessFailure]);

  return (
    <AdminChangelogContext.Provider value={value}>
      {children}
    </AdminChangelogContext.Provider>
  );
}

export function useAdminChangelog(): AdminChangelogContextValue {
  const context = useContext(AdminChangelogContext);
  if (context === null) {
    throw new Error("Admin changelog pages must be rendered inside AdminChangelogRouteBoundary.");
  }
  return context;
}

export function isBoundaryAccessFailure(
  value: { readonly kind: string },
): value is BoundaryAccessFailure {
  return value.kind === "auth-expired"
    || value.kind === "reauthentication-required"
    || value.kind === "denied";
}

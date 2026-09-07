import { ApiError, fetchJson } from "./client";

export type AdminAccessResult =
  | { readonly kind: "ok" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication-required" }
  | { readonly kind: "degraded"; readonly message: string };

export type CheckAdminAccess = (signal?: AbortSignal) => Promise<AdminAccessResult>;

/** Access checks never depend on a business-data endpoint or session freshness. */
export const checkAdminAccess: CheckAdminAccess = async (signal) => {
  try {
    const result = await fetchJson<{ allowed: boolean }>("/api/v1/admin/access", { signal });
    if (result.allowed === true) return { kind: "ok" };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ApiError) {
      if (error.status === 401) return { kind: "auth-expired" };
      if (error.status === 403) return { kind: "denied" };
    }
  }
  return { kind: "degraded", message: "Relay could not check platform access. Try again." };
};

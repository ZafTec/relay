import { fetchJsonResponse } from "./client";

export interface SuperadminInvitation {
  id: string;
  email: string;
  createdAt?: string;
  expiresAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
}
export interface SuperadminAccess {
  admins: { userId: string; name: string; email: string; grantedAt: string }[];
  invitations: SuperadminInvitation[];
}
const root = "/api/v1/admin/superadmins";
export const superadminAccess = {
  async list(signal?: AbortSignal): Promise<SuperadminAccess> {
    return (await fetchJsonResponse<SuperadminAccess>(root, { signal })).data;
  },
  async invite(email: string, key: string): Promise<SuperadminInvitation> {
    return (await fetchJsonResponse<SuperadminInvitation>(`${root}/invitations`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ email }) })).data;
  },
  async revoke(id: string): Promise<void> {
    await fetchJsonResponse(`${root}/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async invitation(id: string, accept = false, signal?: AbortSignal): Promise<{ email: string; accepted: boolean; expiresAt?: string }> {
    return (await fetchJsonResponse<{ email: string; accepted: boolean; expiresAt?: string }>(`/api/v1/superadmin-invitations/${encodeURIComponent(id)}`, { signal, ...(accept ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true }) } : {}) })).data;
  },
};

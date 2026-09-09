import { fetchJson } from "./client";

export interface WorkspaceDetails {
  name: string;
  slug: string;
}
export interface WorkspaceUpdate extends WorkspaceDetails {
  logo?: string | null;
}
export interface ManagedWorkspace extends WorkspaceDetails {
  id: string;
  role: string;
  personal: boolean;
  logo?: string | null;
}
export interface WorkspaceList {
  items: ManagedWorkspace[];
  maxOwnedWorkspaces: number;
}
export interface WorkspaceAdapter {
  list(signal?: AbortSignal): Promise<WorkspaceList>;
  propose(): Promise<WorkspaceDetails>;
  create(
    details: WorkspaceDetails,
    key: string,
  ): Promise<{ workspace: ManagedWorkspace; replayed: boolean }>;
  update(id: string, details: WorkspaceUpdate): Promise<ManagedWorkspace>;
  remove(id: string, confirmation: string): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid workspace response");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Invalid workspace text");
  }
  return value;
}
function details(value: unknown): WorkspaceDetails {
  const v = object(value);
  return { name: text(v.name), slug: text(v.slug) };
}
function workspace(value: unknown): ManagedWorkspace {
  const v = object(value);
  if (typeof v.personal !== "boolean") {
    throw new TypeError("Invalid workspace kind");
  }
  return {
    ...details(v),
    id: text(v.id),
    role: text(v.role),
    personal: v.personal,
    logo: typeof v.logo === "string" ? v.logo : null,
  };
}
const ROOT = "/api/v1/workspaces";
export const httpWorkspaceAdapter: WorkspaceAdapter = {
  async remove(id, confirmation) {
    const result = object(
      await fetchJson(`${ROOT}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }),
      }),
    );
    if (result.deleted !== true) {
      throw new TypeError("Workspace deletion was not confirmed");
    }
  },
  async list(signal) {
    const result = object(await fetchJson(ROOT, { signal }));
    if (
      !Array.isArray(result.items) || result.items.length > 1000 ||
      !Number.isSafeInteger(result.maxOwnedWorkspaces) ||
      (result.maxOwnedWorkspaces as number) < 1
    ) throw new TypeError("Invalid workspace list");
    return {
      items: result.items.map(workspace),
      maxOwnedWorkspaces: result.maxOwnedWorkspaces as number,
    };
  },
  async propose() {
    return details(await fetchJson(`${ROOT}/suggestion`));
  },
  async create(input, key) {
    const result = object(
      await fetchJson(ROOT, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(input),
      }),
    );
    if (typeof result.replayed !== "boolean") {
      throw new TypeError("Invalid workspace receipt");
    }
    return {
      workspace: workspace(result.workspace),
      replayed: result.replayed,
    };
  },
  async update(id, input) {
    const result = object(
      await fetchJson(`${ROOT}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    return workspace(result.workspace);
  },
};

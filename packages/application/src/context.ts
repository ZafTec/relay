export interface WorkspaceActorContext {
  readonly workspaceId: string;
  readonly actorUserId: string;
}

const MAX_IDENTITY_LENGTH = 255;

function validateIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_IDENTITY_LENGTH || value.trim() !== value ||
    /[\r\n\0]/.test(value)
  ) {
    throw new TypeError(`${field} has an invalid format`);
  }
  return value;
}

export function validateWorkspaceActorContext(
  context: WorkspaceActorContext,
): WorkspaceActorContext {
  return {
    workspaceId: validateIdentity(context.workspaceId, "workspaceId"),
    actorUserId: validateIdentity(context.actorUserId, "actorUserId"),
  };
}

export function validateIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 255 ||
    value.trim() !== value || /[\r\n\0]/.test(value)
  ) {
    throw new TypeError("idempotencyKey has an invalid format");
  }
  return value;
}

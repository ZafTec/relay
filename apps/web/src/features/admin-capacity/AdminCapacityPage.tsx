import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import {
  httpAdminCapacityAdapter,
  type AdminCapacityAdapter,
  type AdminCapacityPolicy,
  type CapacityPolicyConfiguration,
  type CapacityPolicyJsonValue,
  type ListAdminCapacityPoliciesRequest,
  type ReviseAdminCapacityPolicyRequest,
} from "../../lib/api/admin-capacity";

const JSON_EDITOR_CHARACTER_LIMIT = 131_072;
const JSON_REQUEST_BYTE_LIMIT = 128 * 1_024;
const POLICY_LIST_LIMIT = 200;
const SCOPE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

let fallbackRequestSequence = 0;

interface CapacityQuery {
  readonly scopeType: string | null;
  readonly scopeId: string | null;
  readonly includeHistory: boolean;
}

interface PreferredPolicy {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly revision?: number;
}

interface ExactRevisionRequest {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly request: ReviseAdminCapacityPolicyRequest;
  readonly idempotencyKey: string;
}

type ReadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly policies: readonly AdminCapacityPolicy[] }
  | { readonly kind: "degraded"; readonly message: string }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication-required" }
  | { readonly kind: "auth-expired" };

type MutationState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting"; readonly exactRetry: boolean }
  | { readonly kind: "success"; readonly revision: number; readonly replayed: boolean }
  | {
      readonly kind: "revision-conflict";
      readonly actualRevision: number;
      readonly refreshed: boolean;
    }
  | { readonly kind: "idempotency-conflict" }
  | {
      readonly kind: "unknown";
      readonly message: string;
      readonly idempotencyKey: string;
    }
  | { readonly kind: "error"; readonly message: string };

interface ConfigurationValue {
  readonly path: string;
  readonly value: string;
}

export interface AdminCapacityPageProps {
  readonly adapter?: AdminCapacityAdapter;
}

function policyKey(policy: AdminCapacityPolicy): string {
  return `${policy.policyId}:${policy.revision}`;
}

function sameScope(
  policy: AdminCapacityPolicy,
  scope: Pick<PreferredPolicy, "scopeType" | "scopeId">,
): boolean {
  return policy.scopeType === scope.scopeType && policy.scopeId === scope.scopeId;
}

function requestKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `capacity:revise:${globalThis.crypto.randomUUID()}`;
  }
  fallbackRequestSequence += 1;
  return `capacity:revise:${Date.now().toString(36)}:${fallbackRequestSequence.toString(36).padStart(6, "0")}`;
}

function toLocalDateTime(isoTimestamp: string | null): string {
  if (isoTimestamp === null) return "";
  const date = new Date(isoTimestamp);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 19);
}

function toIsoTimestamp(localTimestamp: string): string | null {
  if (localTimestamp.trim() === "") return null;
  const date = new Date(localTimestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function configurationValues(configuration: CapacityPolicyConfiguration): readonly ConfigurationValue[] {
  const values: ConfigurationValue[] = [];
  const visit = (value: CapacityPolicyJsonValue, path: string) => {
    if (values.length >= 32) return;
    if (value === null || typeof value !== "object") {
      values.push({ path, value: value === null ? "null" : String(value) });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    const objectValue = value as CapacityPolicyConfiguration;
    Object.keys(objectValue).sort().forEach((key) => {
      visit(objectValue[key]!, path === "$" ? key : `${path}.${key}`);
    });
  };
  visit(configuration, "$");
  return values;
}

function listRequest(query: CapacityQuery): ListAdminCapacityPoliciesRequest {
  return {
    ...(query.scopeType === null ? {} : { scopeType: query.scopeType }),
    ...(query.scopeId === null ? {} : { scopeId: query.scopeId }),
    includeHistory: query.includeHistory,
    limit: POLICY_LIST_LIMIT,
  };
}

function sameQuery(left: CapacityQuery, right: CapacityQuery): boolean {
  return left.scopeType === right.scopeType
    && left.scopeId === right.scopeId
    && left.includeHistory === right.includeHistory;
}

export function AdminCapacityPage({
  adapter = httpAdminCapacityAdapter,
}: AdminCapacityPageProps) {
  const [query, setQuery] = useState<CapacityQuery>({
    scopeType: null,
    scopeId: null,
    includeHistory: false,
  });
  const [scopeTypeInput, setScopeTypeInput] = useState("");
  const [scopeIdInput, setScopeIdInput] = useState("");
  const [viewInput, setViewInput] = useState<"current" | "history">("current");
  const [filterError, setFilterError] = useState<string | null>(null);
  const [readState, setReadState] = useState<ReadState>({ kind: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [effectiveAtInput, setEffectiveAtInput] = useState("");
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [mutationState, setMutationState] = useState<MutationState>({ kind: "idle" });
  const [pendingExactRequest, setPendingExactRequest] = useState<ExactRevisionRequest | null>(null);

  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const selectedKeyRef = useRef<string | null>(null);

  const hydrateEditor = useCallback((policy: AdminCapacityPolicy, clearFeedback: boolean) => {
    const nextKey = policyKey(policy);
    selectedKeyRef.current = nextKey;
    setSelectedKey(nextKey);
    setJsonText(JSON.stringify(policy.configuration, null, 2));
    setEffectiveAtInput(toLocalDateTime(policy.effectiveAt));
    setExpiresAtInput(toLocalDateTime(policy.expiresAt));
    setEditorError(null);
    setPendingExactRequest(null);
    if (clearFeedback) setMutationState({ kind: "idle" });
  }, []);

  const clearSelection = useCallback(() => {
    selectedKeyRef.current = null;
    setSelectedKey(null);
    setJsonText("");
    setEffectiveAtInput("");
    setExpiresAtInput("");
    setEditorError(null);
    setPendingExactRequest(null);
  }, []);

  const loadPolicies = useCallback(async (
    nextQuery: CapacityQuery,
    preferred?: PreferredPolicy,
  ): Promise<AdminCapacityPolicy | null> => {
    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setReadState({ kind: "loading" });

    try {
      const result = await adapter.list(listRequest(nextQuery), controller.signal);
      if (!mountedRef.current || generation !== loadGenerationRef.current) return null;

      switch (result.kind) {
        case "ok": {
          setReadState({ kind: "ready", policies: result.policies });
          if (result.policies.length === 0) {
            clearSelection();
            return null;
          }
          const preferredPolicy = preferred === undefined
            ? undefined
            : result.policies.find((policy) =>
              sameScope(policy, preferred)
              && (preferred.revision === undefined || policy.revision === preferred.revision))
              ?? result.policies.find((policy) => sameScope(policy, preferred));
          const retainedPolicy = result.policies.find((policy) =>
            policyKey(policy) === selectedKeyRef.current);
          const nextPolicy = preferredPolicy ?? retainedPolicy ?? result.policies[0]!;
          hydrateEditor(nextPolicy, false);
          return nextPolicy;
        }
        case "denied":
          setReadState({ kind: "denied" });
          clearSelection();
          return null;
        case "reauthentication-required":
          setReadState({ kind: "reauthentication-required" });
          clearSelection();
          return null;
        case "auth-expired":
          setReadState({ kind: "auth-expired" });
          clearSelection();
          return null;
        case "not-found":
          setReadState({ kind: "ready", policies: [] });
          clearSelection();
          return null;
        case "degraded":
          setReadState({ kind: "degraded", message: result.message });
          return null;
      }
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return null;
      setReadState({
        kind: "degraded",
        message: error instanceof Error
          ? "Relay could not load capacity policies. Try the request again."
          : "Relay could not load capacity policies.",
      });
      return null;
    }
  }, [adapter, clearSelection, hydrateEditor]);

  useEffect(() => {
    mountedRef.current = true;
    void loadPolicies(query);
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      loadAbortRef.current?.abort();
    };
  }, [loadPolicies, query]);

  const selectedPolicy = useMemo(() => {
    if (readState.kind !== "ready" || selectedKey === null) return null;
    return readState.policies.find((policy) => policyKey(policy) === selectedKey) ?? null;
  }, [readState, selectedKey]);

  const visibleConfigurationValues = useMemo(
    () => selectedPolicy === null ? [] : configurationValues(selectedPolicy.configuration),
    [selectedPolicy],
  );

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scopeType = scopeTypeInput.trim();
    const scopeId = scopeIdInput.trim();
    if (scopeId !== "" && scopeType === "") {
      setFilterError("Scope ID requires a scope type.");
      return;
    }
    if (scopeType !== "" && !SCOPE_TYPE_PATTERN.test(scopeType)) {
      setFilterError("Scope type must start with a lowercase letter and use lowercase letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    setFilterError(null);
    setMutationState({ kind: "idle" });
    const nextQuery: CapacityQuery = {
      scopeType: scopeType === "" ? null : scopeType,
      scopeId: scopeId === "" ? null : scopeId,
      includeHistory: viewInput === "history",
    };
    if (sameQuery(query, nextQuery)) void loadPolicies(nextQuery);
    else setQuery(nextQuery);
  }

  function clearFilters() {
    setScopeTypeInput("");
    setScopeIdInput("");
    setViewInput("current");
    setFilterError(null);
    setMutationState({ kind: "idle" });
    const nextQuery: CapacityQuery = {
      scopeType: null,
      scopeId: null,
      includeHistory: false,
    };
    if (sameQuery(query, nextQuery)) void loadPolicies(nextQuery);
    else setQuery(nextQuery);
  }

  function applyRevisedPolicy(policy: AdminCapacityPolicy) {
    setReadState((current) => {
      if (current.kind !== "ready") return { kind: "ready", policies: [policy] };
      const retained = current.policies.filter((candidate) => {
        if (candidate.policyId === policy.policyId) return false;
        return query.includeHistory || !sameScope(candidate, policy);
      });
      return { kind: "ready", policies: [policy, ...retained] };
    });
    hydrateEditor(policy, false);
  }

  async function executeRevision(exactRequest: ExactRevisionRequest, exactRetry: boolean) {
    const generation = ++mutationGenerationRef.current;
    setMutationState({ kind: "submitting", exactRetry });
    const result = await adapter.revise(
      exactRequest.scopeType,
      exactRequest.scopeId,
      exactRequest.request,
      exactRequest.idempotencyKey,
    );
    if (!mountedRef.current || generation !== mutationGenerationRef.current) return;

    switch (result.kind) {
      case "revised":
        setPendingExactRequest(null);
        applyRevisedPolicy(result.value);
        setMutationState({
          kind: "success",
          revision: result.value.revision,
          replayed: result.replayed,
        });
        return;
      case "revision-conflict": {
        setPendingExactRequest(null);
        const refreshed = await loadPolicies(query, {
          scopeType: exactRequest.scopeType,
          scopeId: exactRequest.scopeId,
          revision: result.actualRevision,
        });
        if (!mountedRef.current || generation !== mutationGenerationRef.current) return;
        setMutationState({
          kind: "revision-conflict",
          actualRevision: result.actualRevision,
          refreshed: refreshed !== null,
        });
        return;
      }
      case "idempotency-conflict":
        setPendingExactRequest(null);
        setMutationState({ kind: "idempotency-conflict" });
        return;
      case "unknown-outcome":
        setPendingExactRequest(exactRequest);
        setMutationState({
          kind: "unknown",
          message: result.message,
          idempotencyKey: exactRequest.idempotencyKey,
        });
        return;
      case "denied":
        setPendingExactRequest(null);
        setReadState({ kind: "denied" });
        return;
      case "reauthentication-required":
        setPendingExactRequest(null);
        setReadState({ kind: "reauthentication-required" });
        return;
      case "auth-expired":
        setPendingExactRequest(null);
        setReadState({ kind: "auth-expired" });
        return;
      case "not-found":
        setPendingExactRequest(null);
        setMutationState({
          kind: "error",
          message: "This policy scope no longer exists. Refresh the policy list before revising.",
        });
        return;
      case "degraded":
        setPendingExactRequest(null);
        setMutationState({ kind: "error", message: result.message });
    }
  }

  function handleRevisionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedPolicy === null) return;
    if (jsonText.length > JSON_EDITOR_CHARACTER_LIMIT) {
      setEditorError(`Policy JSON must be ${JSON_EDITOR_CHARACTER_LIMIT.toLocaleString()} characters or fewer.`);
      return;
    }

    let configuration: CapacityPolicyConfiguration;
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setEditorError("Policy JSON must have an object at its root.");
        return;
      }
      const serialized = JSON.stringify(parsed);
      if (new TextEncoder().encode(serialized).byteLength > JSON_REQUEST_BYTE_LIMIT) {
        setEditorError("Policy JSON exceeds the 128 KiB request limit.");
        return;
      }
      configuration = parsed as CapacityPolicyConfiguration;
    } catch {
      setEditorError("Policy JSON is not valid. Correct the document before creating a revision.");
      return;
    }

    const effectiveAt = toIsoTimestamp(effectiveAtInput);
    if (effectiveAt === null) {
      setEditorError("Enter a valid effective time.");
      return;
    }
    const expiresAt = expiresAtInput.trim() === "" ? null : toIsoTimestamp(expiresAtInput);
    if (expiresAtInput.trim() !== "" && expiresAt === null) {
      setEditorError("Enter a valid expiry time or leave it blank.");
      return;
    }
    if (expiresAt !== null && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()) {
      setEditorError("Expiry must be later than the effective time.");
      return;
    }

    setEditorError(null);
    const exactRequest: ExactRevisionRequest = {
      scopeType: selectedPolicy.scopeType,
      scopeId: selectedPolicy.scopeId,
      request: {
        expectedRevision: selectedPolicy.revision,
        configuration,
        effectiveAt,
        expiresAt,
      },
      idempotencyKey: requestKey(),
    };
    setPendingExactRequest(exactRequest);
    void executeRevision(exactRequest, false);
  }

  const editorLocked = mutationState.kind === "submitting" || mutationState.kind === "unknown";

  return (
    <article className="admin-capacity-page">
      <header className="admin-page-header capacity-page-header">
        <div>
          <h1>Capacity policies</h1>
          <p className="capacity-page-header__summary">
            Review tool capacity and update the limits that govern execution.
          </p>
        </div>
        <span className="capacity-mode" aria-label="Current interface mode: Operate">Operate</span>
      </header>

      <div className="admin-page-body capacity-page-body">
        <form className="capacity-filters" aria-label="Filter capacity policies" onSubmit={handleFilterSubmit}>
          <div className="capacity-filters__heading">
            <div>
              <h2>Policy ledger</h2>
              <p>Use raw scope coordinates. Current view returns one effective policy per scope.</p>
            </div>
            <span>{query.includeHistory ? "Revision history" : "Current policies"}</span>
          </div>
          <div className="capacity-filter-grid">
            <div className="admin-field">
              <label htmlFor="capacity-scope-type">Scope type</label>
              <input
                className="admin-input admin-input--mono"
                id="capacity-scope-type"
                name="scopeType"
                value={scopeTypeInput}
                disabled={editorLocked}
                onChange={(event) => setScopeTypeInput(event.target.value)}
                placeholder="e.g. tool"
                autoComplete="off"
              />
            </div>
            <div className="admin-field capacity-filter-grid__scope-id">
              <label htmlFor="capacity-scope-id">Raw scope ID</label>
              <input
                className="admin-input admin-input--mono"
                id="capacity-scope-id"
                name="scopeId"
                value={scopeIdInput}
                disabled={editorLocked}
                onChange={(event) => setScopeIdInput(event.target.value)}
                placeholder="Exact stored identifier"
                autoComplete="off"
              />
            </div>
            <div className="admin-field">
              <label htmlFor="capacity-view">Revision view</label>
              <select
                className="admin-select"
                id="capacity-view"
                name="view"
                value={viewInput}
                disabled={editorLocked}
                onChange={(event) => setViewInput(event.target.value as "current" | "history")}
              >
                <option value="current">Current only</option>
                <option value="history">Full history</option>
              </select>
            </div>
            <div className="capacity-filter-actions">
              <Button type="submit" disabled={editorLocked}>Apply filters</Button>
              <Button type="button" variant="quiet" disabled={editorLocked} onClick={clearFilters}>Clear</Button>
            </div>
          </div>
          {filterError ? <p className="capacity-field-error" role="alert">{filterError}</p> : null}
        </form>

        {readState.kind === "loading" ? (
          <section className="capacity-state" aria-live="polite" aria-busy="true">
            <p className="capacity-state__code">POLICY_READ</p>
            <h2>Loading capacity policies</h2>
            <div className="capacity-loading-lines" aria-hidden="true"><span /><span /><span /></div>
          </section>
        ) : null}

        {readState.kind === "degraded" ? (
          <section className="capacity-state capacity-state--error" role="alert">
            <p className="capacity-state__code">READ_FAILED</p>
            <h2>Capacity policies unavailable</h2>
            <p>{readState.message}</p>
            <Button type="button" onClick={() => void loadPolicies(query)}>Try again</Button>
          </section>
        ) : null}

        {readState.kind === "denied" ? (
          <section className="capacity-state capacity-state--error" role="alert">
            <p className="capacity-state__code">ACCESS_DENIED</p>
            <h2>Capacity access denied</h2>
            <p>Your authenticated account cannot inspect or revise platform capacity policies.</p>
            <Link className="capacity-link" to="/dashboard">Return to workspace</Link>
          </section>
        ) : null}

        {readState.kind === "reauthentication-required" || readState.kind === "auth-expired" ? (
          <section className="capacity-state capacity-state--error" role="alert">
            <p className="capacity-state__code">REAUTH_REQUIRED</p>
            <h2>Reauthentication required</h2>
            <p>
              {readState.kind === "auth-expired"
                ? "Your session expired before the capacity request completed."
                : "Confirm your identity again before operating on capacity policies."}
            </p>
            <Link
              className="capacity-link"
              to="/sign-in?returnTo=%2Fadmin%2Fcapacity&reason=session-expired"
            >
              Reauthenticate
            </Link>
          </section>
        ) : null}

        {readState.kind === "ready" && readState.policies.length === 0 ? (
          <section className="capacity-state" aria-live="polite">
            <p className="capacity-state__code">NO_MATCH</p>
            <h2>No capacity policies found</h2>
            <p>No stored policy matches this scope and revision view. Adjust the filters to continue.</p>
          </section>
        ) : null}

        {readState.kind === "ready" && readState.policies.length > 0 ? (
          <div className="capacity-workspace">
            <section className="capacity-ledger" aria-labelledby="capacity-ledger-title">
              <div className="capacity-section-heading">
                <div>
                  <p className="capacity-section-heading__code">{String(readState.policies.length).padStart(2, "0")}</p>
                  <h2 id="capacity-ledger-title">{query.includeHistory ? "Policy history" : "Current policy set"}</h2>
                </div>
                <p>Select a row to inspect its stored document and revision coordinates.</p>
              </div>
              <div className="capacity-table-region">
                <table className="capacity-table">
                  <caption className="sr-only">
                    {query.includeHistory ? "Capacity policy revision history" : "Current capacity policies"}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Scope</th>
                      <th scope="col">Revision</th>
                      <th scope="col">Effective</th>
                      <th scope="col">Expiry</th>
                      <th scope="col"><span className="sr-only">Inspect</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {readState.policies.map((policy) => {
                      const isSelected = policyKey(policy) === selectedKey;
                      return (
                        <tr key={policyKey(policy)} aria-selected={isSelected || undefined}>
                          <th scope="row">
                            <span>{policy.scopeType}</span>
                            <code>{policy.scopeId}</code>
                          </th>
                          <td><strong>r{policy.revision}</strong><small>ID {policy.policyId}</small></td>
                          <td><time dateTime={policy.effectiveAt}>{policy.effectiveAt}</time></td>
                          <td>
                            {policy.expiresAt === null
                              ? <span className="capacity-never">No expiry</span>
                              : <time dateTime={policy.expiresAt}>{policy.expiresAt}</time>}
                          </td>
                          <td>
                            <button
                              className="capacity-inspect-button"
                              type="button"
                              aria-pressed={isSelected}
                              disabled={editorLocked}
                              onClick={() => hydrateEditor(policy, true)}
                            >
                              {isSelected ? "Selected" : "Inspect"}
                              <span className="sr-only"> {policy.scopeType} {policy.scopeId} revision {policy.revision}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {selectedPolicy ? (
              <section className="capacity-detail" aria-labelledby="capacity-detail-title">
                <div className="capacity-section-heading capacity-detail__heading">
                  <div>
                    <p className="capacity-section-heading__code">SELECTED / R{selectedPolicy.revision}</p>
                    <h2 id="capacity-detail-title">Policy detail</h2>
                  </div>
                  <span className="capacity-policy-state">Stored</span>
                </div>

                <dl className="capacity-metadata">
                  <div><dt>Scope type</dt><dd><code>{selectedPolicy.scopeType}</code></dd></div>
                  <div><dt>Raw scope ID</dt><dd><code>{selectedPolicy.scopeId}</code></dd></div>
                  <div><dt>Policy ID</dt><dd><code>{selectedPolicy.policyId}</code></dd></div>
                  <div><dt>Revision</dt><dd><code>{selectedPolicy.revision}</code></dd></div>
                  <div><dt>Effective at</dt><dd><time dateTime={selectedPolicy.effectiveAt}>{selectedPolicy.effectiveAt}</time></dd></div>
                  <div><dt>Expires at</dt><dd>{selectedPolicy.expiresAt === null ? "No expiry" : <time dateTime={selectedPolicy.expiresAt}>{selectedPolicy.expiresAt}</time>}</dd></div>
                  <div className="capacity-metadata__wide"><dt>Immutable hash</dt><dd><code>{selectedPolicy.immutableHash}</code></dd></div>
                </dl>

                <section className="capacity-values" aria-labelledby="capacity-values-title">
                  <div>
                    <h3 id="capacity-values-title">Values from stored JSON</h3>
                    <p>Derived from this revision, not application defaults.</p>
                  </div>
                  {visibleConfigurationValues.length > 0 ? (
                    <dl>
                      {visibleConfigurationValues.map((entry) => (
                        <div key={entry.path}>
                          <dt><code>{entry.path}</code></dt>
                          <dd><code>{entry.value}</code></dd>
                        </div>
                      ))}
                    </dl>
                  ) : <p className="capacity-values__empty">This policy stores an empty JSON object.</p>}
                  {visibleConfigurationValues.length === 32 ? (
                    <p className="capacity-values__note">Additional values remain available in the complete JSON document.</p>
                  ) : null}
                </section>

                <form className="capacity-revision-form" onSubmit={handleRevisionSubmit}>
                  <div className="capacity-revision-form__heading">
                    <div>
                      <p className="capacity-section-heading__code">OPTIMISTIC WRITE</p>
                      <h3>Create revision {selectedPolicy.revision + 1}</h3>
                    </div>
                    <p>Expected revision <code>{selectedPolicy.revision}</code> is fixed to the selected policy.</p>
                  </div>

                  {mutationState.kind !== "idle" ? (
                    <div
                      className={`capacity-feedback capacity-feedback--${mutationState.kind}`}
                      role={mutationState.kind === "success" || mutationState.kind === "submitting" ? "status" : "alert"}
                      aria-live="polite"
                    >
                      {mutationState.kind === "submitting" ? (
                        <><strong>{mutationState.exactRetry ? "Retrying exact request" : "Submitting revision"}</strong><p>No automatic retry will be attempted.</p></>
                      ) : null}
                      {mutationState.kind === "success" ? (
                        <>
                          <strong>{mutationState.replayed ? "Replay confirmed" : "Revision created"}</strong>
                          <p>
                            {mutationState.replayed
                              ? `The stored request was replayed safely at revision ${mutationState.revision}; no duplicate revision was created.`
                              : `Capacity policy revision ${mutationState.revision} is now selected.`}
                          </p>
                        </>
                      ) : null}
                      {mutationState.kind === "revision-conflict" ? (
                        <>
                          <strong>Revision conflict</strong>
                          <p>
                            The server is at revision {mutationState.actualRevision}.
                            {mutationState.refreshed
                              ? " The latest policy was refreshed; review its complete JSON before trying again."
                              : " The latest policy could not be refreshed."}
                          </p>
                        </>
                      ) : null}
                      {mutationState.kind === "idempotency-conflict" ? (
                        <>
                          <strong>Idempotency key conflict</strong>
                          <p>The request key is already bound to different content. Review the policy and submit a new request to generate a new key.</p>
                        </>
                      ) : null}
                      {mutationState.kind === "unknown" ? (
                        <>
                          <strong>Revision outcome unknown</strong>
                          <p>{mutationState.message}</p>
                          <dl><dt>Stable request key</dt><dd><code>{mutationState.idempotencyKey}</code></dd></dl>
                          <Button
                            type="button"
                            onClick={() => {
                              if (pendingExactRequest !== null) void executeRevision(pendingExactRequest, true);
                            }}
                          >
                            Retry exact request
                          </Button>
                        </>
                      ) : null}
                      {mutationState.kind === "error" ? (
                        <><strong>Revision not created</strong><p>{mutationState.message}</p></>
                      ) : null}
                    </div>
                  ) : null}

                  <fieldset disabled={editorLocked}>
                    <legend className="sr-only">Capacity policy revision fields</legend>
                    <div className="capacity-date-grid">
                      <div className="admin-field">
                        <label htmlFor="capacity-effective-at">Effective at</label>
                        <input
                          className="admin-input admin-input--mono"
                          id="capacity-effective-at"
                          type="datetime-local"
                          step="1"
                          required
                          value={effectiveAtInput}
                          onChange={(event) => setEffectiveAtInput(event.target.value)}
                        />
                      </div>
                      <div className="admin-field">
                        <label htmlFor="capacity-expires-at">Expires at <span>(optional)</span></label>
                        <input
                          className="admin-input admin-input--mono"
                          id="capacity-expires-at"
                          type="datetime-local"
                          step="1"
                          value={expiresAtInput}
                          onChange={(event) => setExpiresAtInput(event.target.value)}
                        />
                      </div>
                    </div>
                    <div className="admin-field capacity-json-field">
                      <div className="capacity-json-field__label">
                        <label htmlFor="capacity-policy-json">Complete policy JSON</label>
                        <span>{jsonText.length.toLocaleString()} / {JSON_EDITOR_CHARACTER_LIMIT.toLocaleString()}</span>
                      </div>
                      <textarea
                        className="admin-textarea capacity-json-editor"
                        id="capacity-policy-json"
                        value={jsonText}
                        maxLength={JSON_EDITOR_CHARACTER_LIMIT}
                        spellCheck={false}
                        aria-invalid={editorError === null ? undefined : true}
                        aria-describedby="capacity-json-guidance capacity-editor-error"
                        onChange={(event) => {
                          setJsonText(event.target.value);
                          setEditorError(null);
                          if (mutationState.kind !== "idle") setMutationState({ kind: "idle" });
                        }}
                      />
                      <p className="admin-field__hint" id="capacity-json-guidance">
                        The entire stored object is editable so extension keys survive revision. The request is also checked against a 128 KiB serialized limit.
                      </p>
                      {editorError ? <p className="capacity-field-error" id="capacity-editor-error" role="alert">{editorError}</p> : <span id="capacity-editor-error" />}
                    </div>
                    <div className="capacity-submit-row">
                      <Button
                        type="submit"
                        pending={mutationState.kind === "submitting"}
                        pendingLabel={mutationState.kind === "submitting" && mutationState.exactRetry
                          ? "Retrying exact request"
                          : "Creating revision"}
                      >
                        Create revision
                      </Button>
                      <p>A unique request key is generated on submit and retained only for exact retries.</p>
                    </div>
                  </fieldset>
                </form>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

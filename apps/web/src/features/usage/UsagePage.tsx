import { type FormEvent, useEffect, useRef, useState } from "react";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  httpUsageAdapter,
  isUsageMetric,
  type UsageAdapter,
  type UsageAdapterResult,
  type UsagePeriod,
  type UsageSummary,
  type UsageSummaryItem,
  type UsageSummaryRequest,
} from "../../lib/api/usage";
import "./usage.css";

interface UsageFilters {
  readonly metric: string;
  readonly period: "" | UsagePeriod;
}

interface UsageFilterErrors {
  readonly metric?: string;
}

type UsagePageState =
  | { readonly kind: "loading" }
  | Exclude<UsageAdapterResult, { readonly kind: "auth-expired" }>;

const EMPTY_FILTERS: UsageFilters = Object.freeze({
  metric: "",
  period: "",
});

const UTC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
  timeZoneName: "short",
});

const PERIOD_LABELS: Readonly<Record<UsagePeriod, string>> = Object.freeze({
  calendar_day: "Calendar day",
  calendar_month: "Calendar month",
  lifetime: "Lifetime",
});

export interface UsagePageProps {
  readonly adapter?: UsageAdapter;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined"
      && error instanceof DOMException
      && error.name === "AbortError")
    || (
      typeof error === "object"
      && error !== null
      && "name" in error
      && error.name === "AbortError"
    )
  );
}

function normalizeFilters(filters: UsageFilters): UsageFilters {
  return {
    metric: filters.metric.trim(),
    period: filters.period,
  };
}

function validateFilters(filters: UsageFilters): UsageFilterErrors {
  if (filters.metric.length === 0 || isUsageMetric(filters.metric)) return {};
  return {
    metric:
      "Use 1 to 128 lowercase letters, numbers, dots, underscores, colons, or hyphens.",
  };
}

function sameFilters(left: UsageFilters, right: UsageFilters): boolean {
  return left.metric === right.metric && left.period === right.period;
}

function hasFilters(filters: UsageFilters): boolean {
  return filters.metric.length > 0 || filters.period.length > 0;
}

function requestFor(filters: UsageFilters): UsageSummaryRequest {
  const period = filters.period === "" ? undefined : filters.period;
  return {
    ...(filters.metric.length === 0 ? {} : { metric: filters.metric }),
    ...(period === undefined ? {} : { period }),
  };
}

function formatTimestamp(value: string): string {
  return UTC_DATE_TIME_FORMATTER.format(new Date(value));
}

function resultSummary(state: UsagePageState): string {
  if (state.kind === "loading") return "Loading current usage";
  if (state.kind === "degraded" || state.kind === "not-found") {
    return "Usage unavailable";
  }
  const count = state.usage.items.length;
  if (count === 0) return "No current buckets";
  return `${count} current ${count === 1 ? "bucket" : "buckets"}${
    state.usage.truncated ? ", response truncated" : ""
  }`;
}

function usageCaption(count: number): string {
  return `Current consumed and reserved usage, ${count} active ${
    count === 1 ? "bucket" : "buckets"
  }`;
}

function UsageTable({ summary }: { readonly summary: UsageSummary }) {
  return (
    <>
      <div className="usage-results__meta">
        <p>
          Generated{" "}
          <time dateTime={summary.generatedAt}>
            {formatTimestamp(summary.generatedAt)}
          </time>
        </p>
        <p>{summary.items.length} {summary.items.length === 1 ? "bucket" : "buckets"} shown</p>
      </div>
      <div
        className="usage-table-scroll"
        role="region"
        aria-label="Scrollable current usage summaries"
        tabIndex={0}
      >
        <table className="usage-table">
          <caption>{usageCaption(summary.items.length)}</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Unit</th>
              <th scope="col">Period</th>
              <th scope="col">Current window</th>
              <th scope="col">Consumed</th>
              <th scope="col">Reserved</th>
            </tr>
          </thead>
          <tbody>
            {summary.items.map((item: UsageSummaryItem, index) => (
              <tr
                key={`${item.metric}:${item.unit}:${item.period}:${item.periodStartsAt}:${index}`}
              >
                <th scope="row"><code>{item.metric}</code></th>
                <td><code>{item.unit}</code></td>
                <td>
                  <span className="usage-period-label">{PERIOD_LABELS[item.period]}</span>
                  <code>{item.period}</code>
                </td>
                <td>
                  <span className="usage-window">
                    <time dateTime={item.periodStartsAt}>
                      {formatTimestamp(item.periodStartsAt)}
                    </time>
                    <span>to</span>
                    <time dateTime={item.periodEndsAt}>
                      {formatTimestamp(item.periodEndsAt)}
                    </time>
                  </span>
                </td>
                <td className="usage-amount usage-amount--consumed">
                  <data value={item.consumedAmount}>{item.consumedAmount}</data>
                </td>
                <td className="usage-amount usage-amount--reserved">
                  <data value={item.reservedAmount}>{item.reservedAmount}</data>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function UsagePage({ adapter = httpUsageAdapter }: UsagePageProps) {
  usePageMetadata("Usage | Relay", "#141A16");
  const { expireSession, session, workspace } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const [draftFilters, setDraftFilters] = useState<UsageFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<UsageFilters>(EMPTY_FILTERS);
  const [filterErrors, setFilterErrors] = useState<UsageFilterErrors>({});
  const [state, setState] = useState<UsagePageState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const activeRef = useRef(false);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    setState({ kind: "loading" });

    void adapter.getSummary(requestFor(appliedFilters), controller.signal).then(
      (result) => {
        if (result.kind === "auth-expired") {
          expireSession(sessionId);
          return;
        }
        if (!activeRef.current || generation !== requestGenerationRef.current) return;
        setState(result);
      },
    ).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || generation !== requestGenerationRef.current
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load the usage summary. No usage data was shown.",
      });
    });

    return () => controller.abort();
  }, [adapter, appliedFilters, expireSession, reloadKey, sessionId]);

  const workspaceLabel = workspace.status === "ready"
    ? `Workspace ${workspace.workspace.id}`
    : "Workspace usage";
  const filtersApplied = hasFilters(appliedFilters);
  const noMatches = state.kind === "ok"
    && state.usage.items.length === 0
    && filtersApplied;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFilters = normalizeFilters(draftFilters);
    const errors = validateFilters(nextFilters);
    setFilterErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (sameFilters(nextFilters, appliedFilters)) {
      setReloadKey((value) => value + 1);
      return;
    }
    setAppliedFilters(nextFilters);
  }

  function clearFilters() {
    setDraftFilters(EMPTY_FILTERS);
    setFilterErrors({});
    if (filtersApplied) setAppliedFilters(EMPTY_FILTERS);
  }

  return (
    <div className="usage-page product-surface">
      <header className="usage-page__header">
        <div>
          <p className="mono-label">{workspaceLabel}</p>
          <h1>Usage</h1>
        </div>
        <div className="usage-page__header-actions">
          <p className="usage-page__summary" aria-live="polite">
            {resultSummary(state)}
          </p>
          <Button
            variant="outline"
            pending={state.kind === "loading"}
            pendingLabel="Refreshing"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
      </header>

      <form
        className="usage-filterbar"
        role="search"
        aria-label="Filter current usage"
        onSubmit={applyFilters}
      >
        <div className="usage-field usage-field--metric">
          <label htmlFor="usage-metric">Metric</label>
          <input
            className="usage-control"
            id="usage-metric"
            name="metric"
            maxLength={128}
            value={draftFilters.metric}
            onChange={(event) => {
              const metric = event.currentTarget.value;
              setDraftFilters((current) => ({ ...current, metric }));
              if (filterErrors.metric !== undefined) setFilterErrors({});
            }}
            placeholder="All metrics"
            spellCheck="false"
            aria-invalid={filterErrors.metric === undefined ? undefined : true}
            aria-describedby={filterErrors.metric === undefined
              ? "usage-metric-hint"
              : "usage-metric-error"}
          />
          {filterErrors.metric === undefined ? (
            <span className="usage-field__hint" id="usage-metric-hint">
              Enter an exact metric key, or leave blank for all metrics.
            </span>
          ) : (
            <span className="usage-field__error" id="usage-metric-error" role="alert">
              {filterErrors.metric}
            </span>
          )}
        </div>

        <div className="usage-field">
          <label htmlFor="usage-period">Period</label>
          <select
            className="usage-control"
            id="usage-period"
            name="period"
            value={draftFilters.period}
            onChange={(event) => {
              const period = event.currentTarget.value as "" | UsagePeriod;
              setDraftFilters((current) => ({ ...current, period }));
            }}
          >
            <option value="">All current periods</option>
            <option value="calendar_day">Calendar day</option>
            <option value="calendar_month">Calendar month</option>
            <option value="lifetime">Lifetime</option>
          </select>
        </div>

        <div className="usage-filterbar__actions">
          <Button type="submit">Apply filters</Button>
          {filtersApplied || hasFilters(draftFilters) ? (
            <Button type="button" variant="quiet" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </form>

      <div className="usage-page__body">
        <section className="usage-scope" aria-labelledby="usage-scope-title">
          <div className="usage-scope__intro">
            <h2 id="usage-scope-title">Current usage buckets</h2>
            <p>
              Values stay in the metric and unit returned by Relay. Amounts are not
              combined across rows.
            </p>
          </div>
          <dl className="usage-scope__measures">
            <div>
              <dt>Consumed</dt>
              <dd>Amount recorded in the active metric bucket.</dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd>Amount currently held in the same metric bucket.</dd>
            </div>
          </dl>
          <p className="usage-scope__boundary">
            <span aria-hidden="true">□</span>
            <span>
              <strong>Contract boundary.</strong>{" "}
              Receipt and breakdown data is not exposed by the current contract.
            </span>
          </p>
        </section>

        <section
          className="usage-results"
          aria-labelledby="usage-results-title"
          aria-busy={state.kind === "loading" || undefined}
        >
          <h2 className="sr-only" id="usage-results-title">Current usage results</h2>

          {state.kind === "loading" ? (
            <Skeleton label="Loading usage summary" lines={5} />
          ) : null}

          {state.kind === "degraded" ? (
            <InlineNotice
              title="Usage summary unavailable"
              tone="error"
              action={(
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Try again
                </Button>
              )}
            >
              <p>{state.message}</p>
            </InlineNotice>
          ) : null}

          {state.kind === "not-found" ? (
            <InlineNotice
              title="Usage summary not found"
              action={(
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Try again
                </Button>
              )}
            >
              <p>
                Relay could not find current usage for the active workspace. No
                usage data was shown.
              </p>
            </InlineNotice>
          ) : null}

          {state.kind === "ok" && state.usage.truncated ? (
            <InlineNotice title="Usage response truncated" tone="warning">
              <p>
                The bounded response omitted additional metric dimensions. Narrow
                the metric or period filters to inspect a smaller result set.
              </p>
            </InlineNotice>
          ) : null}

          {state.kind === "ok" && state.usage.items.length === 0 && !filtersApplied ? (
            <EmptyState
              label="Usage summary"
              title="No current usage"
              actions={(
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Check again
                </Button>
              )}
            >
              <p>
                The API returned no active usage buckets for this workspace.
                Consumed and reserved values will appear when a current bucket is
                available.
              </p>
            </EmptyState>
          ) : null}

          {noMatches ? (
            <div className="usage-no-match" role="status">
              <h2>No current usage matches these filters</h2>
              <p>
                Change the metric or period to inspect the active usage buckets
                returned for this workspace.
              </p>
              <Button variant="outline" onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : null}

          {state.kind === "ok" && state.usage.items.length > 0 ? (
            <UsageTable summary={state.usage} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

export const UsageSummaryPage = UsagePage;

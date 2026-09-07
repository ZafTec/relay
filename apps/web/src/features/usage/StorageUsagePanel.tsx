import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import type {
  StorageUsageAdapter,
  StorageUsageResult,
} from "../../lib/api/storage-usage";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
const INTEGER_FORMAT = new Intl.NumberFormat("en-US");

export function formatStorageBytes(value: string): string {
  const count = BigInt(value);
  let divisor = 1n;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && count >= divisor * 1024n) {
    divisor *= 1024n;
    unit++;
  }
  if (unit === 0) return `${INTEGER_FORMAT.format(count)} B`;
  const tenths = (count * 10n + divisor / 2n) / divisor;
  return `${INTEGER_FORMAT.format(tenths / 10n)}.${tenths % 10n} ${
    BYTE_UNITS[unit]
  }`;
}

function ByteValue({ value }: { readonly value: string }) {
  return (
    <data value={value} title={`${INTEGER_FORMAT.format(BigInt(value))} bytes`}>
      {formatStorageBytes(value)}
    </data>
  );
}

type StorageState =
  | { readonly kind: "loading" }
  | Exclude<StorageUsageResult, { kind: "auth-expired" }>;

export function StorageUsagePanel({ adapter, reloadKey }: {
  readonly adapter: StorageUsageAdapter;
  readonly reloadKey: number;
}) {
  const { expireSession, session } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const [state, setState] = useState<StorageState>({ kind: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ kind: "loading" });
    void adapter.getStorageSummary(controller.signal).then((result) => {
      if (!active) return;
      if (result.kind === "auth-expired") expireSession(sessionId);
      else setState(result);
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setState({ kind: "unavailable" });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [adapter, expireSession, reloadKey, retryKey, sessionId]);

  const storage = state.kind === "ok" ? state.storage : null;
  const occupied = storage === null
    ? 0n
    : BigInt(storage.storedBytes) + BigInt(storage.reservedBytes);
  const limit = storage?.limitBytes == null ? null : BigInt(storage.limitBytes);
  const percent = limit === null || limit === 0n ? 0 : Number(
    (occupied * 1000n) / limit > 1000n ? 1000n : (occupied * 1000n) / limit,
  ) / 10;

  return (
    <section
      className="usage-storage"
      aria-labelledby="usage-storage-title"
      aria-busy={state.kind === "loading" || undefined}
    >
      <div className="usage-storage__heading">
        <div>
          <h2 id="usage-storage-title">Storage</h2>
          <p>Files and versions saved in this workspace.</p>
        </div>
        {storage !== null
          ? (
            <p className="usage-storage__available">
              {storage.availableBytes === null ? "No storage cap" : (
                <>
                  <ByteValue value={storage.availableBytes} />{" "}available
                </>
              )}
            </p>
          )
          : null}
      </div>
      {state.kind === "loading"
        ? <Skeleton label="Loading workspace storage" lines={2} />
        : null}
      {state.kind === "unavailable"
        ? (
          <InlineNotice
            title="Storage usage unavailable"
            tone="error"
            action={
              <Button
                variant="outline"
                onClick={() => setRetryKey((value) => value + 1)}
              >
                Retry storage
              </Button>
            }
          >
            <p>
              Relay could not load current storage usage and capacity. Try again
              to see the latest values.
            </p>
          </InlineNotice>
        )
        : null}
      {storage !== null
        ? (
          <>
            <div className="usage-storage__capacity">
              <p>
                <ByteValue value={occupied.toString()} />{" "}
                used and reserved{storage.limitBytes !== null
                  ? (
                    <>
                      {" "}of <ByteValue value={storage.limitBytes} />
                    </>
                  )
                  : null}
              </p>
              {limit !== null
                ? (
                  <div
                    className="usage-storage__meter"
                    role="meter"
                    aria-label="Workspace storage capacity"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-valuetext={`${
                      formatStorageBytes(occupied.toString())
                    } used and reserved of ${
                      formatStorageBytes(storage.limitBytes!)
                    }`}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                )
                : null}
            </div>
            <dl className="usage-storage__breakdown">
              <div>
                <dt>Stored files</dt>
                <dd>
                  <ByteValue value={storage.storedBytes} />
                  <p>Includes previous versions and files awaiting deletion.</p>
                </dd>
              </div>
              <div>
                <dt>Uploads in progress</dt>
                <dd>
                  <ByteValue
                    value={(BigInt(storage.reservedBytes) -
                      BigInt(storage.cleanupPendingBytes)).toString()}
                  />
                  <p>Space reserved for uploads and tool outputs.</p>
                </dd>
              </div>
              <div>
                <dt>Waiting for cleanup</dt>
                <dd>
                  <ByteValue value={storage.cleanupPendingBytes} />
                  <p>
                    Reserved space released after abandoned uploads are removed.
                  </p>
                </dd>
              </div>
            </dl>
            {limit !== null && occupied >= limit
              ? (
                <p className="usage-storage__limit" role="status">
                  Storage capacity reached. Space becomes available after files
                  are permanently removed or the limit is increased.
                </p>
              )
              : null}
            <p className="usage-storage__note">
              Space is freed after cleanup finishes. Storage is separate from
              tool usage below.
            </p>
          </>
        )
        : null}
    </section>
  );
}

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import { UsagePage } from "../../src/features/usage/UsagePage";
import { formatStorageBytes } from "../../src/features/usage/StorageUsagePanel";
import {
  httpStorageUsageAdapter,
  parseStorageUsageResponse,
  type StorageUsageAdapter,
  type StorageUsageResult,
  type StorageUsageSummary,
} from "../../src/lib/api/storage-usage";

const storage: StorageUsageSummary = {
  generatedAt: "2030-04-12T15:30:00.000Z",
  storedBytes: "40000000",
  reservedBytes: "15000000",
  cleanupPendingBytes: "5000000",
  limitBytes: "100000000",
  availableBytes: "45000000",
};
const auth = createTestAuthAdapter({
  identity: {
    session: {
      id: "session-storage",
      userId: "user-storage",
      expiresAt: null,
      activeWorkspaceId: "ws-storage",
    },
    user: {
      id: "user-storage",
      name: "Storage Operator",
      email: "storage@example.test",
      image: null,
    },
  },
  activeWorkspace: {
    id: "ws-storage",
    name: "Storage workspace",
    slug: "storage-workspace",
  },
});
const usage = {
  getSummary: vi.fn(async () => ({
    kind: "ok" as const,
    usage: {
      generatedAt: storage.generatedAt,
      items: [],
      truncated: false,
    },
  })),
};

function renderStorage(adapter: StorageUsageAdapter) {
  return render(
    <MemoryRouter>
      <AuthProvider adapter={auth}>
        <UsagePage adapter={usage} storageAdapter={adapter} />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("storage usage", () => {
  it("shows storage without tool buckets and keeps cleanup part of the reserved total", async () => {
    renderStorage({ getStorageSummary: async () => ({ kind: "ok", storage }) });
    const panel = await screen.findByRole("region", { name: "Storage" });
    await within(panel).findByText("40.0 MB");
    expect(within(panel).getByText("10.0 MB")).toBeVisible();
    expect(within(panel).getByText("5.0 MB")).toBeVisible();
    expect(within(panel).getByText("45.0 MB")).toBeVisible();
    expect(within(panel).getByText("55.0 MB")).toBeVisible();
    expect(panel).toHaveTextContent("55.0 MB used and reserved of 100.0 MB");
    expect(panel).toHaveTextContent("45.0 MB available");
    expect(within(panel).getByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "55",
    );
    expect(
      await screen.findByRole("heading", { name: "No current tool usage" }),
    ).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Metric"), "image.generations");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(within(panel).getByText("45.0 MB")).toBeVisible();
  });

  it("distinguishes unavailable storage from real zero and retries independently", async () => {
    const user = userEvent.setup();
    const getStorageSummary = vi.fn()
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValue({
        kind: "ok",
        storage: {
          ...storage,
          storedBytes: "0",
          reservedBytes: "0",
          cleanupPendingBytes: "0",
          availableBytes: storage.limitBytes,
        },
      });
    renderStorage({ getStorageSummary });
    const panel = await screen.findByRole("region", { name: "Storage" });
    await within(panel).findByText("Storage usage unavailable");
    expect(within(panel).queryByText("0 B")).not.toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Retry storage" }),
    );
    await within(panel).findByRole("meter");
    expect(within(panel).getAllByText("0 B")).toHaveLength(4);
    expect(within(panel).getByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("renders a lowered cap as exhausted without negative space or an overflowing meter", async () => {
    renderStorage({
      getStorageSummary: async () => ({
        kind: "ok",
        storage: { ...storage, limitBytes: "1024", availableBytes: "0" },
      }),
    });
    const panel = await screen.findByRole("region", { name: "Storage" });
    expect(await within(panel).findByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "Storage capacity reached",
    );
  });

  it("does not display an older in-flight result after the storage adapter changes", async () => {
    let resolve!: (result: StorageUsageResult) => void;
    const old = {
      getStorageSummary: () =>
        new Promise<StorageUsageResult>((complete) => {
          resolve = complete;
        }),
    };
    const current = {
      getStorageSummary: async () => ({ kind: "ok" as const, storage }),
    };
    function tree(adapter: StorageUsageAdapter) {
      return (
        <MemoryRouter>
          <AuthProvider adapter={auth}>
            <UsagePage adapter={usage} storageAdapter={adapter} />
          </AuthProvider>
        </MemoryRouter>
      );
    }
    const view = render(tree(old));
    await waitFor(() => expect(resolve).toBeDefined());
    view.rerender(tree(current));
    await screen.findByText("45.0 MB");
    await act(async () =>
      resolve({
        kind: "ok",
        storage: {
          ...storage,
          storedBytes: "0",
          reservedBytes: "0",
          cleanupPendingBytes: "0",
          availableBytes: storage.limitBytes,
        },
      })
    );
    expect(screen.getByText("45.0 MB")).toBeVisible();
  });
});

describe("storage API precision", () => {
  it("keeps bytes beyond Number.MAX_SAFE_INTEGER exact and rejects inconsistent data", async () => {
    const large = {
      ...storage,
      storedBytes: "9007199254740993",
      reservedBytes: "7",
      cleanupPendingBytes: "2",
      limitBytes: "9007199254741010",
      availableBytes: "10",
    };
    expect(parseStorageUsageResponse({ kind: "ok", storage: large })).toEqual(
      large,
    );
    expect(formatStorageBytes(large.storedBytes)).toBe("9.0 PB");
    expect(formatStorageBytes("0")).toBe("0 B");
    expect(() =>
      parseStorageUsageResponse({
        kind: "ok",
        storage: { ...large, storedBytes: 9007199254740993 },
      })
    ).toThrow();
    expect(() =>
      parseStorageUsageResponse({
        kind: "ok",
        storage: { ...large, availableBytes: "11" },
      })
    ).toThrow();
    expect(() =>
      parseStorageUsageResponse({
        kind: "ok",
        storage: { ...large, cleanupPendingBytes: "10" },
      })
    ).toThrow();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ kind: "ok", storage: large }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await httpStorageUsageAdapter.getStorageSummary()).toEqual({
        kind: "ok",
        storage: large,
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/usage/storage");
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

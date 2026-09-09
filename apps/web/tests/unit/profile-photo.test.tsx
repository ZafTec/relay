import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import { ProfilePhotoEditor } from "../../src/features/profile/ProfilePhotoEditor";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";

const mocks = vi.hoisted(() => ({ accountInfo: vi.fn(), updateUser: vi.fn() }));
vi.mock("../../src/auth/auth-client", () => ({ authClient: mocks }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("uses the linked account's provider image URL and saves only after confirmation", async () => {
  const providerImage = "https://avatars.githubusercontent.com/u/12345?v=4";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify([{ id: "local-account", providerId: "github" }]),
        { headers: { "content-type": "application/json" } },
      )
    ),
  );
  mocks.accountInfo.mockResolvedValue({
    data: { user: { image: providerImage } },
  });
  mocks.updateUser.mockResolvedValue({ data: { status: true } });
  const user = userEvent.setup();
  const adapter = createTestAuthAdapter({
    identity: {
      session: {
        id: "s",
        userId: "u",
        expiresAt: null,
        activeWorkspaceId: "w",
      },
      user: {
        id: "u",
        name: "Avery",
        email: "avery@example.test",
        image: null,
      },
    },
    activeWorkspace: { id: "w", name: "Studio", slug: "studio" },
  });
  render(
    <MemoryRouter>
      <AuthProvider adapter={adapter}>
        <Routes><Route element={<ProtectedRoute />}><Route path="/" element={<ProfilePhotoEditor image={null} />} /></Route></Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  await user.click(await screen.findByText("Change profile photo"));
  await user.click(
    await screen.findByRole("button", { name: "Use GitHub photo" }),
  );
  expect(mocks.accountInfo).toHaveBeenCalledWith({
    query: { accountId: "local-account" },
  });
  expect(mocks.updateUser).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save photo" }));
  await waitFor(() =>
    expect(mocks.updateUser).toHaveBeenCalledWith({ image: providerImage })
  );
  expect(await screen.findByText("Profile photo saved.")).toBeInTheDocument();

  await user.click(screen.getByText("Use an image URL"));
  const urlInput = screen.getByRole("textbox", { name: "Profile photo URL" });
  await user.clear(urlInput);
  const customImage = "https://images.example.test/profile.png";
  await user.type(urlInput, customImage);
  expect(urlInput).toHaveValue(customImage);
  expect(mocks.updateUser).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Save photo" }));
  await waitFor(() => expect(mocks.updateUser).toHaveBeenLastCalledWith({ image: customImage }));
});

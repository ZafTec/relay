import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "../../src/features/settings/NotificationSettings";
import { notificationsApi } from "../../src/lib/api/notifications";
vi.mock("../../src/lib/api/notifications", () => ({ notificationsApi: { get: vi.fn(), update: vi.fn() } }));
const initial = { configured:true, completed:false, failed:false, deliveries:[] };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(notificationsApi.get).mockResolvedValue(initial); });
const mount = () => render(<MemoryRouter><NotificationSettings email="person@example.test" /></MemoryRouter>);
it("keeps email disabled until the user chooses and saves preferences", async () => {
  const user = userEvent.setup(); mount();
  const completed = await screen.findByRole("checkbox", { name: /Run completed/ });
  expect(completed).not.toBeChecked(); expect(notificationsApi.update).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save preferences" })).toBeDisabled();
  await user.click(completed); expect(notificationsApi.update).not.toHaveBeenCalled();
  vi.mocked(notificationsApi.update).mockResolvedValue({ ...initial, completed:true });
  await user.click(screen.getByRole("button", {name:"Save preferences"}));
  expect(await screen.findByText("Email preferences saved.")).toBeInTheDocument();
  expect(notificationsApi.update).toHaveBeenCalledWith({ completed:true, failed:false });
});
it("requires a refresh after an ambiguous save failure", async () => {
  const user = userEvent.setup(); vi.mocked(notificationsApi.update).mockRejectedValue(new Error("network")); mount();
  await user.click(await screen.findByRole("checkbox",{name:/Run failed/}));
  await user.click(screen.getByRole("button",{name:"Save preferences"}));
  await screen.findByRole("alert"); expect(screen.getByRole("button",{name:"Save preferences"})).toBeDisabled();
  vi.mocked(notificationsApi.get).mockResolvedValue({...initial,failed:true});
  await user.click(screen.getByRole("button",{name:"Refresh settings"}));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("checkbox",{name:/Run failed/})).toBeChecked();
});
it("disables opt-in when SMTP is not configured", async () => {
  vi.mocked(notificationsApi.get).mockResolvedValue({...initial,configured:false}); mount();
  expect(await screen.findByRole("checkbox",{name:/Run completed/})).toBeDisabled();
  expect(screen.getByText("Email is not configured")).toBeInTheDocument();
});

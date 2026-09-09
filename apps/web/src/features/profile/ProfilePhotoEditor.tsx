import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { authClient } from "../../auth/auth-client";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { ImagePicker } from "../../components/ui/ImagePicker";
import { fetchJson } from "../../lib/api/client";

interface Account {
  id: string;
  providerId: string;
}
export function ProfilePhotoEditor({ image }: { image: string | null }) {
  const { refreshSession } = useAuth();
  const [draft, setDraft] = useState(image);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [accountsError, setAccountsError] = useState(false);
  const [accountsRetry, setAccountsRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAccountsError(false);
    void fetchJson<Account[]>("/api/auth/list-accounts", {
      signal: controller.signal,
    }).then((value) => {
      if (!controller.signal.aborted && Array.isArray(value)) {
        setAccounts(value.filter((account) =>
          typeof account.id === "string" &&
          ["google", "github"].includes(account.providerId)
        ));
      }
    }).catch(() => {
      if (!controller.signal.aborted) setAccountsError(true);
    });
    return () => controller.abort();
  }, [accountsRetry]);
  async function useProvider(account: Account) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await authClient.accountInfo({
        query: { accountId: account.id },
      });
      if (result.error || !result.data?.user.image) throw new Error();
      const url = new URL(result.data.user.image);
      if (url.protocol !== "https:") throw new Error();
      setDraft(url.href);
    } catch {
      setError(
        "Couldn’t get your provider photo. Sign in again to refresh the connection, or choose an image.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await authClient.updateUser({ image: draft });
      if (result.error) throw new Error();
      await refreshSession({ preserveView: true });
      setSaved(true);
    } catch {
      setError(
        "Couldn’t save your photo. Check the image or URL and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Disclosure title="Change profile photo" className="profile-photo-editor">
      <ImagePicker
        label="Profile photo"
        value={draft}
        onChange={(value) => {
          setDraft(value);
          setSaved(false);
        }}
        disabled={busy}
        onBusyChange={setBusy}
      />
      {accounts.length
        ? (
          <div className="profile-photo-editor__providers">
            {accounts.map((account) => (
              <Button
                key={account.id}
                variant="outline"
                disabled={busy}
                onClick={() => void useProvider(account)}
              >
                Use {account.providerId === "google" ? "Google" : "GitHub"}{" "}
                photo
              </Button>
            ))}
          </div>
        )
        : null}
      {accountsError
        ? (
          <p role="status">
            Couldn’t load your linked accounts.{" "}
            <Button
              variant="quiet"
              onClick={() =>
                setAccountsRetry((value) => value + 1)}
            >
              Try again
            </Button>
          </p>
        )
        : null}
      <Button
        pending={busy}
        disabled={draft === image}
        onClick={() => void save()}
      >
        Save photo
      </Button>
      {saved ? <p role="status">Profile photo saved.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </Disclosure>
  );
}

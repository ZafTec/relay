import { RelayBrand } from "../brand/RelayBrand";
import { Button } from "./Button";
import { InlineNotice } from "./InlineNotice";
import { Skeleton } from "./Skeleton";

interface LoadingPageStateProps {
  label: string;
}

export function LoadingPageState({ label }: LoadingPageStateProps) {
  return (
    <main className="page-state product-surface">
      <RelayBrand surface="product" />
      <div className="page-state__panel">
        <p className="mono-label">Session boundary</p>
        <h1>{label}</h1>
        <Skeleton label={label} lines={2} />
      </div>
    </main>
  );
}

interface DegradedPageStateProps {
  title: string;
  message: string;
  onRetry: () => void;
}

export function DegradedPageState({ title, message, onRetry }: DegradedPageStateProps) {
  return (
    <main className="page-state product-surface">
      <RelayBrand surface="product" />
      <div className="page-state__panel">
        <p className="mono-label">Session boundary</p>
        <h1>{title}</h1>
        <InlineNotice
          title="Request not completed"
          tone="error"
          action={<Button variant="outline" onClick={onRetry}>Try again</Button>}
        >
          <p>{message}</p>
        </InlineNotice>
      </div>
    </main>
  );
}

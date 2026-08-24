import { usePageMetadata } from "../../app/usePageMetadata";
import { RelayBrand } from "../../components/brand/RelayBrand";
import { LinkButton } from "../../components/ui/Button";

export function NotFoundPage() {
  usePageMetadata("Page not found | Relay", "#141A16");
  return (
    <main className="page-state product-surface">
      <RelayBrand surface="product" />
      <div className="page-state__panel not-found">
        <p className="mono-label">404 / Not found</p>
        <h1>This Relay route does not exist</h1>
        <p>No resource was changed. Return to the public site or open the protected dashboard.</p>
        <div className="inline-actions">
          <LinkButton to="/" variant="outline">Public site</LinkButton>
          <LinkButton to="/dashboard">Dashboard</LinkButton>
        </div>
      </div>
    </main>
  );
}

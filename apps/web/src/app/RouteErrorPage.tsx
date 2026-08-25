import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { RelayBrand } from "../components/brand/RelayBrand";
import { LinkButton } from "../components/ui/Button";
import { InlineNotice } from "../components/ui/InlineNotice";

export function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `Relay could not render this route (HTTP ${error.status}).`
    : "Relay could not render this route. No data was changed.";

  return (
    <main className="page-state product-surface">
      <RelayBrand surface="product" />
      <div className="page-state__panel">
        <InlineNotice title="Route unavailable" tone="error" action={<LinkButton to="/" variant="outline">Return home</LinkButton>}>
          <p>{message}</p>
        </InlineNotice>
      </div>
    </main>
  );
}

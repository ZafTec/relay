import { Link } from "react-router-dom";

interface RelayBrandProps {
  surface?: "public" | "product";
  compact?: boolean;
  showParent?: boolean;
}

export function RelayBrand({
  surface = "public",
  compact = false,
  showParent = true,
}: RelayBrandProps) {
  const mark = surface === "product"
    ? "/relay/brand/relay-mark-reverse.svg"
    : "/relay/brand/relay-mark.svg";

  return (
    <Link className="relay-brand" to="/" aria-label="Relay home">
      <img
        className="relay-brand__mark"
        src={mark}
        width={compact ? 22 : 26}
        height={compact ? 22 : 26}
        alt=""
      />
      <span className="relay-brand__name">Relay</span>
      {showParent ? <span className="relay-brand__parent">by ZafTech</span> : null}
    </Link>
  );
}

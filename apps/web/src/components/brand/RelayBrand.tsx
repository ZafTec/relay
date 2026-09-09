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
  const size = compact ? 22 : 26;

  return (
    <Link className="relay-brand" to="/" aria-label="Relay home">
      {surface === "product" ? (
        // The product surface follows the OS/browser color scheme (see globals.css),
        // so the mark must switch with it: the "reverse" ramp reads on a dark rail,
        // the base ramp reads on a light one.
        <picture>
          <source srcSet="/relay/brand/relay-mark-reverse.svg" media="(prefers-color-scheme: dark)" />
          <img
            className="relay-brand__mark"
            src="/relay/brand/relay-mark.svg"
            width={size}
            height={size}
            alt=""
          />
        </picture>
      ) : (
        <img
          className="relay-brand__mark"
          src="/relay/brand/relay-mark.svg"
          width={size}
          height={size}
          alt=""
        />
      )}
      <span className="relay-brand__name">Relay</span>
      {showParent ? <span className="relay-brand__parent">by ZafTech</span> : null}
    </Link>
  );
}

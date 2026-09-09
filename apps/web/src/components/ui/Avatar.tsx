import { useState } from "react";

export function Avatar(
  { src, fallback, className }: {
    src?: string | null;
    fallback: string;
    className: string;
  },
) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={className} aria-hidden="true">
      {src && failed !== src
        ? (
          <img
            src={src}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailed(src)}
          />
        )
        : fallback}
    </span>
  );
}

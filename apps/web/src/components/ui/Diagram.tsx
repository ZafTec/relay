interface DiagramProps {
  src: string;
  alt: string;
  label: string;
  caption?: string;
  minWidth?: number;
  className?: string;
}

export function Diagram({
  src,
  alt,
  label,
  caption,
  minWidth = 720,
  className,
}: DiagramProps) {
  return (
    <figure
      className={["diagram", className].filter(Boolean).join(" ")}
      tabIndex={0}
      aria-label={label}
    >
      <img src={src} alt={alt} style={{ minWidth }} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

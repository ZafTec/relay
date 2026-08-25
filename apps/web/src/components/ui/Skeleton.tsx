interface SkeletonProps {
  label: string;
  lines?: number;
}

export function Skeleton({ label, lines = 3 }: SkeletonProps) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="skeleton__kicker" aria-hidden="true" />
      <div className="skeleton__title" aria-hidden="true" />
      {Array.from({ length: lines }, (_, index) => (
        <div className="skeleton__line" aria-hidden="true" key={index} />
      ))}
    </div>
  );
}

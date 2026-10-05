export function SkeletonList({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <p className="skeleton-label">{label}</p>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} aria-hidden="true" />
      ))}
    </div>
  );
}

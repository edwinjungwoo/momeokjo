export function SkeletonList({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <div className="skeleton-head">
        <img
          className="mascot"
          src="/brand/pose-go.png"
          alt=""
          aria-hidden="true"
          width={57}
          height={64}
          loading="lazy"
          draggable={false}
        />
        <p className="skeleton-label">{label}</p>
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} aria-hidden="true" />
      ))}
    </div>
  );
}

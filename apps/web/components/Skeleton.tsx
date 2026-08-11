import type { CSSProperties } from 'react';

/** One shimmer block. Size it like the content it stands in for. */
export function Skeleton({
  h = '1rem',
  w = '100%',
  style,
}: {
  h?: string;
  w?: string;
  style?: CSSProperties;
}) {
  return <span className="skeleton" aria-hidden style={{ height: h, width: w, ...style }} />;
}

/** A card-shaped stack of shimmer lines — the generic "this card is loading". */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-hidden>
      <Skeleton h="1.05rem" w="40%" style={{ marginBottom: '0.7rem' }} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          h="0.85rem"
          w={i === lines - 1 ? '55%' : '90%'}
          style={{ marginBottom: '0.45rem' }}
        />
      ))}
    </div>
  );
}

/**
 * The specd mark.
 *
 * A witch's hat, because the palette was already phosphor-on-black and the
 * silhouette survives being shrunk to a favicon in a way a face never would.
 *
 * The idea it has to carry is approval — that is the product. So the brim does
 * double duty: read it as a hat, then notice it is also the stroke of a check.
 * A mark that means the thing beats a mark that merely decorates it.
 *
 * Drawn on a 32×32 grid so it lands on whole pixels at 16 and 32.
 */

export type LogoVariant = 'face' | 'check' | 'seal' | 'spec' | 'plain';

export function Logo({
  variant = 'check',
  size = 28,
  title,
}: {
  variant?: LogoVariant;
  size?: number;
  title?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    role: title ? ('img' as const) : ('presentation' as const),
    'aria-hidden': title ? undefined : true,
  };

  // The cone, with the slight lean that makes a hat read as a *witch's* hat
  // rather than a traffic cone.
  const cone =
    'M11.4 3.2c3.6 2.2 6.6 7 8.6 11.1.6 1.3 1.2 2.1 2 2.7H10.1c1.5-3.8 2-9.1 1.3-13.8Z';
  const brim =
    'M9.6 17h12.8c3.8.5 6.2 1.7 6.2 3 0 2-5.6 3.6-12.6 3.6S3.4 22 3.4 20c0-1.3 2.3-2.5 6.2-3Z';

  switch (variant) {
    /*
     * The brand mark: black hat, green face, red lips.
     *
     * It carries its own green field because a black hat on a near-black page
     * is invisible — this is a tile, the way app icons are. The brim crosses
     * the face and hides the eyes, which is what makes the silhouette read as
     * a witch at a glance and keeps the shape simple enough to survive.
     *
     * Drawn from scratch: a pointed hat and a green face are broad archetype,
     * the cropped-face-under-brim composition of a particular poster is not.
     */
    case 'face':
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <rect width="32" height="32" rx="7.5" fill="var(--brand-green, #00be2c)" />
          {/* face — a soft oval tapering to a chin */}
          <path
            d="M16 7c4.6 0 6 3.6 6 9 0 4.2-1.2 8-3 10.2-1 1.2-2 2.3-3 2.3s-2-1.1-3-2.3c-1.8-2.2-3-6-3-10.2 0-5.4 1.4-9 6-9Z"
            fill="var(--brand-face, #b6f5ce)"
          />
          {/* the smile — the one warm note in the mark */}
          <path
            d="M13.3 21.4c1.5 2.2 3.9 2.2 5.4 0"
            stroke="var(--brand-red, #ff0080)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
          {/* nose, barely — enough to make it a face and not an egg */}
          <path
            d="M16 18.4c.7.8 1.1 1.4 1.1 1.8 0 .4-.5.6-1.1.6"
            stroke="var(--brand-green, #00be2c)"
            strokeWidth="0.9"
            strokeLinecap="round"
            opacity="0.5"
            fill="none"
          />
          {/* hat last, so the brim shadows the eyes away */}
          <g transform="rotate(-7 16 14)">
          <path
            d="M13.2.6c3.8 2.2 7 5.4 8.8 8.2H10.2c1.8-2.4 2.9-5.2 3-8.2Z"
            fill="var(--brand-black, #07100b)"
          />
          <path
            d="M9.8 8.6h12.4c5.8.5 9.5 2 9.5 3.7 0 2.7-7 5.1-15.7 5.1S.3 15 .3 12.3c0-1.7 3.7-3.2 9.5-3.7Z"
            fill="var(--brand-black, #07100b)"
          />
          </g>
        </svg>
      );

    case 'seal':
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <circle cx="16" cy="16" r="14.5" stroke="currentColor" strokeWidth="1.6" opacity="0.55" />
          <g transform="translate(0 -0.5) scale(0.82) translate(3.5 4)">
            <path d={cone} fill="currentColor" />
            <path d={brim} fill="currentColor" />
          </g>
        </svg>
      );

    case 'spec':
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <g transform="translate(0 -2)">
            <path d={cone} fill="currentColor" />
            <path d={brim} fill="currentColor" />
          </g>
          <rect x="7" y="24" width="18" height="2.2" rx="1.1" fill="currentColor" opacity="0.85" />
          <rect x="7" y="28.4" width="11" height="2.2" rx="1.1" fill="currentColor" opacity="0.45" />
        </svg>
      );

    case 'plain':
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path d={cone} fill="currentColor" />
          <path d={brim} fill="currentColor" />
        </svg>
      );

    case 'check':
    default:
      // The brim IS the check. Crossing a separate tick through the hat
      // destroyed the silhouette — the two shapes fought and neither read.
      // Here one stroke sweeps under the cone and flicks up, so the hat reads
      // first and the tick second, which is the order that matters.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path d="M11.8 3c3.5 2.2 6.4 6.9 8.3 10.9.5 1.1 1 1.8 1.7 2.3H10.6C12 12.6 12.5 7.6 11.8 3Z" fill="currentColor" />
          <path
            d="M4 17.8c2.6 3.6 8 5.6 13.4 4.4l11-12.6"
            stroke="currentColor"
            strokeWidth="3.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
  }
}

/** Mark plus wordmark, as it appears in the nav. */
export function Wordmark({
  variant = 'check',
  size = 26,
}: {
  variant?: LogoVariant;
  size?: number;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
      <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
        <Logo variant={variant} size={size} title="specd" />
      </span>
      <span style={{ font: `700 ${size * 0.62}px/1 var(--serif)`, color: '#fff' }}>
        spec<i style={{ color: 'var(--accent)', fontStyle: 'normal' }}>d</i>
      </span>
    </span>
  );
}

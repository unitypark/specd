/**
 * The specd mark.
 *
 * Four interlocking hooks: identical circular arcs, each centered 6 units
 * off the mark's own center point and swept 220° (leaving a 140° opening),
 * rotated 90° apart. Replaces the earlier golden-spiral construction — on
 * direct instruction, referencing a bold geometric pinwheel mark as a style
 * cue (a stock-logo listing, watermarked, used only for its general
 * *technique* — offset arcs arranged in rotation — never traced; the
 * specific curves are that reference's, not copied here; see the decision
 * doc for the full reasoning). Each hook's opening is centered 40° off its
 * own outward-facing direction, not on it — a gap centered on the radial
 * direction reads as a static four-petal flower (every hook symmetric
 * around its own axis, no sense of motion); offsetting it is what makes
 * the shapes chase each other into a genuine woven pinwheel, the same way
 * the previous spiral construction's weave came from four asymmetric arcs
 * rather than four symmetric ones. Confirmed at 16/24/32/48px before
 * settling here — bolder, simpler geometry than the spiral it replaced,
 * and reads clearly even smaller.
 *
 * Pure currentColor by default, no embedded fill. Nothing here needs a
 * colored tile for contrast, so it drops straight onto light or dark
 * surfaces unchanged.
 *
 * Drawn on a 32×32 grid so it lands on whole pixels at 16 and 32. Legible
 * down to a 16px favicon — measured, not assumed.
 */

import { useId } from 'react';

const HOOK = 'M8.48 7.26A8 8 0 1 1 20 16.93';

export function Logo({
  size = 28,
  title,
  glow = false,
}: {
  size?: number;
  title?: string;
  /**
   * A soft white bloom behind a white line, on direct instruction
   * referencing Cresta's mark as a style cue — not traced (their two-loop
   * layout isn't ours to copy; only the *treatment* is): no black outline,
   * a bolder stroke than the flat mark's.
   *
   * The blur is masked by a circular radial gradient, not left to fall off
   * on its own — this mark has 4-fold rotational symmetry (four arms, each
   * reaching toward a different edge of the icon), and blurring a shape
   * with discrete rotational symmetry produces a halo that inherits that
   * symmetry: a soft *rounded square*, not a circle, dimmer along the
   * diagonals than along the arms. At this mark's weight it read as a
   * visible square-ish patch behind the line — reported back as "weird
   * background color", which is exactly what it was: not a colour, a
   * shape, but indistinguishable from one at a glance. Confirmed by
   * rendering the raw filter output against a neutral mid-grey (where
   * neither a "too dark" nor "too light" artifact could hide the way it
   * would against black or white) before concluding it was real. Widening
   * the filter's own region did not fix it, because the region was never
   * clipping anything — the squareness is the blurred shape itself, not a
   * cropped edge. A `mask` referencing a `radialGradient` forces the
   * *visible* falloff back to a true circle regardless of what shape
   * produced it underneath.
   *
   * The mask alone wasn't the whole fix: the four arms don't quite meet at
   * the exact center, leaving a small natural gap there (visible as a tiny
   * dark notch even on the flat, unblurred mark) — the *first* mask
   * attempt was fully opaque at that center point, so the blur's own soft
   * bleed into the gap passed straight through and read as a small grey
   * smudge sitting on the mark. Making the mask transparent at the center
   * too (a ring instead of a disc) made this worse, not better — it
   * sharpened the gap into a harder-edged dark spot instead of softening
   * it away. What actually worked: leaving the mask a plain disc and
   * tightening both blur passes (0.9/2, down from 1.5/3.2) so there is
   * simply less intensity to bleed into that gap in the first place. Tried
   * in that order, on screenshots, not reasoned to in one step.
   *
   * Two rejected constructions before this one — see the decision doc's
   * addenda: a flat `currentColor` stroke had no way to read as white on
   * the one dark surface it needs to (the nav pill); a black-outline
   * version put black on top of the mark, which at this stroke weight and
   * four-arm overlap read as "a black mark with a thin white rim" rather
   * than white. Self-adjusting the same way every version has: on a
   * white/near-white surface the white blur and line both sit close
   * enough to the ground to read as quiet, but on a dark surface (the
   * nav's own floating pill) the identical markup produces real presence.
   * Carries its own fixed colour, so it's an explicit per-instance choice,
   * not the default: softens the silhouette at favicon scale, the same
   * reason the flat mark drops detail below ~24px rather than keep it
   * everywhere.
   */
  glow?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const filterId = `${uid}-glow`;
  const gradientId = `${uid}-glow-grad`;
  const maskId = `${uid}-glow-mask`;
  const weight = glow ? 3.4 : 2.9;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? ('img' as const) : ('presentation' as const)}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {glow && (
        <defs>
          <filter id={filterId} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="0.9" result="b1" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b2" />
            <feMerge>
              <feMergeNode in="b2" />
              <feMergeNode in="b1" />
            </feMerge>
          </filter>
          {/* Forces the blur's falloff into a true circle — see the glow
              prop's doc comment for why the raw blur can't be trusted to
              do this on its own for a 4-fold-symmetric shape. */}
          <radialGradient id={gradientId} cx="16" cy="16" r="15" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="45%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id={maskId}>
            <rect x="-16" y="-16" width="64" height="64" fill={`url(#${gradientId})`} />
          </mask>
        </defs>
      )}
      {glow && (
        <g mask={`url(#${maskId})`}>
          <g
            fill="none"
            stroke="#ffffff"
            strokeWidth={weight}
            strokeLinecap="round"
            filter={`url(#${filterId})`}
          >
            <path d={HOOK} />
            <path d={HOOK} transform="rotate(90 16 16)" />
            <path d={HOOK} transform="rotate(180 16 16)" />
            <path d={HOOK} transform="rotate(270 16 16)" />
          </g>
        </g>
      )}
      <g fill="none" stroke={glow ? '#ffffff' : 'currentColor'} strokeWidth={weight} strokeLinecap="round">
        <path d={HOOK} />
        <path d={HOOK} transform="rotate(90 16 16)" />
        <path d={HOOK} transform="rotate(180 16 16)" />
        <path d={HOOK} transform="rotate(270 16 16)" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark, as it appears in the nav. */
export function Wordmark({ size = 26, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
      <span style={{ color: 'var(--ink)', display: 'inline-flex' }}>
        <Logo size={size} title="specd" glow={glow} />
      </span>
      <span style={{ font: `700 ${size * 0.62}px/1 var(--serif)`, color: 'var(--ink)' }}>
        {/* No colour: the "d" is set apart by staying genuinely italic,
            same treatment as landing.module.css's .logo i. */}
        spec<i style={{ fontStyle: 'italic' }}>d</i>
      </span>
    </span>
  );
}

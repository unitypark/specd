# 0007 — Rebrand: witch mark retired for a golden-spiral mark

- **Status:** accepted
- **Date:** 2026-08-08
- **Project:** specd

## Context

The witch's-hat mark (`apps/web/components/Logo.tsx`) and its palette — sourced
explicitly from "Wicked: Glinda and Elphaba" (green for grounded, pink for
`UNVERIFIED`) — were retired on direct product-owner instruction, in favor of a
mark and palette with no mascot: minimal white/black, reading as "futuristic,"
and expressing "loop" in the mark's own construction rather than as a separate
decoration. The old palette's own name and rationale (`DESIGN.md`'s "Palette"
section, `globals.css`'s header comment) were tied to the witch specifically —
once the mark retires, the palette's reason for existing retires with it. There
was no way to keep one and not the other.

A reference image was supplied for direction (a pinwheel/spiral mark). It carries
a visible marketplace watermark ("PREMIUM LOGO FOR SALE") — it was used only as a
style cue (bold rotational blades, high contrast, woven negative space), never
traced, consistent with this repo's own existing rule that the mark must be
"drawn from scratch" (`DESIGN.md`, "The mark").

## Decision

### The mark

Four identical arms, each the same logarithmic ("golden") spiral centerline —
`r(θ) = r0·φ^(2θ/π)`, φ = 1.6180339887…, the curve "the Fibonacci spiral" refers
to (every quarter turn multiplies the radius by φ) — rotated 90° apart, drawn as
a constant-width stroke. The woven look is not hand-arranged: it falls out of
four arcs sharing a center, the same way any two curves in the same
neighborhood cross. No embedded fill or tile color — pure `currentColor`, so
unlike the old mark it drops onto light or dark surfaces unchanged.

Two earlier directions were tried and rejected before this one:

- Tapered single/double-arm "comet" spirals (blade width shrinking to a point at
  both ends). Read as elegant in isolation but didn't match the reference
  direction once shown, and a 4-arm version of the same taper overlapped into an
  unreadable solid blob rather than a woven pinwheel.
- A 4-arm version tinted every other arm gray to fake an over/under weave.
  Confirmed unnecessary by direct comparison: at full single-color white the line
  crossings alone read as "woven," the same way the reference does.

A rounded-square clip (to flatten two edges the way the reference does) was
considered and explicitly declined: it necessarily clips two of the four arms
and not the other two, breaking the rotational symmetry a mark also has to carry
as a free-standing favicon, not just inside a fixed card.

Self-tested (headless-Chrome screenshots, both this mark and the two rejected
directions) at 128/96/48/32/24/16px, both light and dark grounds, before
settling here — a design that only works large enough is a design that fails as
a favicon, which is exactly what happened to the previous mark's fuller
variants.

### The palette

`apps/web/app/globals.css`'s D12 "minimal monochrome" palette is retitled and
re-sourced: near-black surfaces (darker than before — `#141416`–`#0e0e10` family
vs. the previous `#202226`–`#1a1c20`, still not pure black, same "nothing is
pure black" reasoning as before, just a deeper register for the brief's
"futuristic" ask), cyan (`#3fe0d0`) replacing green as the one accent
(approved/grounded/primary actions), magenta (`#ff5cd6`/`#ff9ee6`) replacing pink
for `UNVERIFIED`. `--danger` and `--warn` are untouched — neither was ever tied
to the witch theme.

Every ink/accent value was re-run through the same WCAG contrast method
`DESIGN.md` already uses (measured against the *lightest* surface a color
actually appears on, not the darkest — the same mistake the old `--ink-3` made
once already). `--ink-3` in particular needed recalculating: at the previous
system's approach (`#87878f`) it scored 4.17 on the new lightest surface
(`--panel-2`), under the 4.5 AA floor for body text; raised to `#8f8f97` (4.64)
to clear it. Paper-safe accent variants (`--cyan-paper`, `--magenta-paper`) were
independently re-darkened against the new `--paper` background for the same
reason the old `--green-paper`/`--pink-paper` existed — raw accent color fails
AA on a light surface.

### The CLI

`cli/cmd/specd/repl.go`'s ASCII mark is an open ring with a small comet-head
flare — not a downsample of the four-arm weave. Rasterizing the actual mark
directly into 13×7 terminal block characters was tried first and turns to mud
regardless of stroke weight; a ring survives coarse block-character sampling far
better than a tapered or woven shape does, while still reading as the same idea
(a spiral, a loop). This is the same move the previous ASCII glyph already made
— dropping the web mark's full witch face for a bare hat silhouette, because
"legible in this medium" and "faithful copy of the SVG" are different goals once
the medium is 13×7 monospace cells. `colorAccent`/`colorInk`/`colorInk3` are the
same hex values `globals.css` now defines, per 0006's original reasoning: not a
separate guess at the brand, the same tokens.

## Addendum (2026-08-08) — glow, as an explicit opt-in

`Logo` gained a `glow` prop (default `false`): a white-hot radial gradient
fading to accent cyan, plus a layered `feGaussianBlur`/`feMerge` bloom, in
place of the flat `currentColor` stroke — on direct instruction, referencing
Cresta's rebrand as a mood cue (HDR-style glow, not a literal design to trace;
same non-tracing rule as the mark itself).

Wired into the two hero-weight placements — nav (`LandingNav.tsx`, 32px) and
the landing page's finale (`page.tsx`, 64px) — not the default, and not the
`/brand` page's size-ladder or the favicon. Prototyped nine treatments (flat
color, blur-only halo at three intensities, gradient-only, gradient+blur at
two intensities, both as linear and radial gradients) before picking one:
wide blur radii looked good at hero size but read as mush at nav's 32px, so
the shipped version uses a *tight* blur (`stdDeviation` 0.8/2.2, not the wider
1.5/4/8 tried first) — legible at nav scale, still visibly glowing at 64px+.

One real bug caught in the process, worth recording because it'll recur: an
SVG `filter`'s blur is not clipped by its element's own box — that's what
makes it a glow rather than a vignette — so a fixed-size demo swatch on the
`/brand` page (sized for the flat mark, reused for the glow one) let a 160px
glow's bloom bleed upward into the paragraph above it. Fixed by scaling each
swatch's padding with the mark size (`Math.round(size * 0.3)`) rather than a
flat value. Anywhere the glow mark sits in a fixed-size container, this is
the failure mode to check for.

Each `Logo` instance generates its own gradient/filter IDs via `useId()`
(sanitized of colons) rather than a fixed id — the mark renders more than
once on the same page (nav + finale), and SVG ids must be document-unique or
the second instance's `url(#id)` silently resolves to the first.

## Addendum (2026-08-08) — cyan replaced with neon green; magenta kept

On direct instruction ("just simple white and black... use neon green as
point color"), the two-cool-accent palette above didn't survive contact with
actual review: `--cyan` (`#3fe0d0`) is replaced by `--green` (`#39ff14`,
renamed, not just re-valued — a token still called `--cyan` holding a green
hex is the kind of thing that reads as a bug to the next person editing it),
and the near-black surface range tightens further (`--bg-2` now literal
`#000000`; the previous `--field`/`--bg`/`--panel`/`--panel-2` family
compresses from `#121214`–`#27272b` to `#050505`–`#1c1c1c`) — starker,
per "simple black and white" taken literally rather than the "charcoal, not
black" register the first pass still had.

`--magenta` is untouched. The instruction named one point color, not zero
non-neutral colors, and `UNVERIFIED` marking a claim the agent could not
ground is a functional signal DESIGN.md is explicit about protecting ("the
colour rules... are how a reviewer tells grounded from unverified at a
glance") — collapsing it to monochrome was a bigger, unrequested product
decision, not a color-taste one, so it wasn't made unilaterally. Flagged
here in case that reading is wrong.

Every value re-run through the same contrast method again — third time
for `--ink-3` specifically, which has now failed the "measure against the
darkest surface instead of the lightest" trap on *every* rebrand pass so
far. `--green-dim` (`#1f9e0a`) came out thin on `--panel-2` too: 4.83
against the 4.5 AA floor, closer to failing than anything else in this
pass. `DESIGN.md`'s contrast table gained a fourth (`--panel-2`) column as
a result — the three-surface version had itself become an instance of the
same mistake it warns against, measuring everything except the lightest
surface it needed to.

Propagated with plain `sed` across every file already touched by the cyan
pass (same locations, both hex and decimal-rgb forms of the same values) —
a controlled, mechanical value swap this time rather than a fresh grep
sweep, since the consumer set was already fully enumerated. One thing that
did need a fresh look: `Logo.tsx`'s glow gradient had a light-cyan midpoint
(`#a8f5ec`) between its white core and accent edge, invisible to a plain
hex/rgb search for the accent color itself since it was never the accent
value — changed to a light green (`#c3ffb8`) so the glow's own gradient
doesn't quietly keep pointing at the retired hue.

## Addendum (2026-08-08) — full flip to a white ground; the glow mechanism rebuilt

On direct instruction ("logo: white glow with black line. background: white.
point color: neon green.") the surfaces inverted: near-black → near-white
(`--field`/`--bg`/`--bg-2`/`--panel`/`--panel-2` now `#fafafa`–`#ececec`,
`--panel` the one true `#ffffff`), `--ink` near-black (`#0f0f0f`). This is not
a value tweak on top of the previous addendum, it's the ground itself moving —
every consequence below follows from that, not from the point colour, which
didn't change.

**Raw `--green`/`--magenta` stopped being viable as text anywhere.** Under the
dark theme they only needed a "-paper" sibling for the rare light card; now
that the whole page is that register, `--green-paper`/`--magenta-paper`
were promoted to first-class, renamed `--green-text`/`--magenta-text` (a
"-paper" token implies "the exception," and on this pass it's the rule).
`--accent` still resolves to raw `--green` — deliberately, because most of
its consumers in `globals.css` are fills and borders (`.btn.primary`
background, focus rings, the meter/spinner), where raw neon is correct and
`-text` would be backwards (dark-green-on-dark-green if it replaced a fill).
The five or so consumers that use `--accent` as actual text colour (`a`,
`.tag`, `.applogo i`, `.pill.on`'s text, `.btn:hover`'s text) were repointed
to `var(--green-text)` individually rather than by flipping the shared
token — a global repoint would have silently broken every fill consumer.

**`--danger` and `--warn` changed for the first time across any pass.**
Both were previously "never touched, not tied to any of this" — true as
long as the ground was dark, since they were tuned to stay visible against
near-black. On white, the old values score 3.23 and 1.74, nowhere near AA.
Re-picked (`#d97070`→`#b83232`, `#d9c470`→`#7a5f00`) for the same reason
everything else got re-picked: measured, not ported.

**One deliberate exception: the nav chrome stays dark.** Its floating pill
(`landing.module.css`'s `.navbar`) was already a hardcoded
`rgba(10, 10, 10, 0.6)`, independent of the page background — so it needed
zero changes to keep working, and it's the one place the new glow mechanism
(below) actually produces a visible halo instead of an invisible one.
Kept on purpose, not missed.

**The glow mechanism itself was rebuilt, not recoloured.** The previous
addendum's version was a single gradient-stroked, blurred path (white core
fading to accent-colour edge) — recolouring it for "white glow, black line"
doesn't work, because a gradient stroke is one path with one colour
progression; a glow and a line that are two *different, unrelated* colours
need two separate layers. Rebuilt as: a blurred white copy of the mark
behind, a crisp black copy on top. Prototyped side by side against white,
gray, and dark grounds before shipping (not assumed): on white or near-white
the white blur is imperceptible and it just reads as a clean black mark; on
a dark surface the identical markup produces a real halo. That's what makes
this construction, not the previous one, the right choice for a mark that
now has to work on a light page by default but still needs to do something
meaningful on the one dark surface (the nav) it also appears on.

**Propagation was a wider, judgment-heavy sweep, not a mechanical value
swap this time.** The previous two passes were "replace hex X with hex Y at
the same call sites" — this one required deciding, file by file, whether a
hardcoded `color: #fff` sat on the general page background (now light, so
it needed to flip to `var(--ink)`) or on an independently-dark element
(a mockup, a chrome pill, a code frame — where white text is still
correct). Dispatched as an agent sweep across the full `apps/web` tree with
the nav carve-out named explicitly, rather than a plain grep-and-replace,
because guessing wrong here doesn't produce a wrong colour, it produces
invisible text.

## Addendum (2026-08-08) — point colour retired entirely; gradation, glow and glass replace it

On direct instruction ("make all black and white only, no point color. use
gradation and glow effect for point of application. also use glass effect
which is trend these days"), `--green`/`--green-dim`/`--green-text` are
removed from `globals.css` outright — not just unused, gone, so a stray
`var(--green)` fails loud instead of quietly resolving to nothing. This is
not a value tweak like the cyan→green swap two addenda back; it's the same
kind of change the white-ground flip was, where the thing moving (a whole
mechanism, not a hex) forces every consumer to be re-decided rather than
re-valued. `--magenta` is untouched, for the same reason it survived the
first "one point color" instruction: `UNVERIFIED` is a functional signal, not
a taste choice, and retiring it wasn't asked for.

### What replaced it

Two new token families, both in `globals.css`:

- `--emphasis`/`--emphasis-hover` (`linear-gradient(160deg, #2e2e2e, #000)`/
  `linear-gradient(160deg, #3c3c3c, #111)`) and `--emphasis-shadow`/
  `--emphasis-shadow-hover` (layered `box-shadow`, black at low alpha, the
  hover variant adding a soft outer ring) — "gradation" is the gradient,
  "glow" is the shadow, always paired, never one without the other.
- `--glass-bg`/`--glass-border`/`--glass-blur` (`rgba(255,255,255,.55)`/
  `rgba(255,255,255,.6)`/`blur(16px) saturate(180%)`) plus a `.glass`
  utility class — glassmorphism, opt-in.

`DESIGN.md` gained "Emphasis" and "Glass" sections under "The graphic layer"
covering both in full, including two mistakes this addendum's own
implementation made and caught by screenshot rather than by review:

1. **The first VS-section glass card was a no-op.** `.card.good`'s own
   `background`/`border-color` were correctly removed to stop them
   outranking `.glass` (0,2,0 vs 0,1,0) — but the plain `.card` rule both
   comparison cards share is *also* a single-class selector, tied with
   `.glass` at 0,1,0, and won on cross-file source order. The "glass" card
   rendered pixel-identical to the flat one next to it until the glass
   values were declared directly on `.card.good` (0,2,0), which beats plain
   `.card` unconditionally. See `DESIGN.md`'s "Glass" section for the full
   account — it's kept there rather than only here because it's a reusable
   lesson about one-class utility overrides, not just a fact about this PR.
2. **The first backdrop behind that same card was too smooth to blur.** A
   `--panel-2`→`--field` radial (both near-white) gave `backdrop-filter`
   nothing with enough tonal difference to visibly smear; replaced with a
   real `rgba(0,0,0,.16)` dark patch.

### The reference sweep needed two passes, not one

`grep -rn "var(--green" apps/web` found 20 direct token references across
`landing.module.css`, `landing-page.module.css`, `compounding-loop.module.css`,
`AgentsView.tsx`, `ticket-to-spec.module.css`, and `Logo.tsx` — all fixed,
each remapped by what it actually was rather than mechanically: small fills
(status dots, a caret, a citation badge) went to plain `--ink`; genuine
points of application (the closing CTA, a "hot" pricing badge, the
knowledge-pile graphic's payoff bars) went to `--emphasis`; nav-chrome text
sitting on the still-dark pill went to white with an opacity-based hover
instead of a colour one, since there's no hue left to shift to.

That grep, by construction, could only find the token. A second sweep for
raw literals (`rgba(57, 255, 20, ...)`, `rgba(255, 92, 214, ...)`, and the
mint/dark-green hexes `#9de8bc`/`#5fce90`/`#0f6b00`-family) caught 11 more
call sites the first pass structurally could not see — the hero's own
opening background wash chief among them (`landing-page.module.css`'s
`.page`, two colored radials, green-left/magenta-right, painted directly on
the page rather than routed through any token). Same lesson the cyan→green
addendum already recorded once (`Logo.tsx`'s light-cyan gradient midpoint,
invisible to a search for the accent hex itself) — a token sweep and a
literal-colour sweep are different searches, and a rebrand needs both. The
hero/finale wash was judged decorative rather than a point of application
(page-wide atmosphere, not tied to any one actionable element) and converted
to a neutral ink-based depth wash rather than an emphasis gradient.

### `.cta` needed a third treatment, not `--emphasis`

Every other button converts cleanly to the dark `--emphasis` gradient because
it lives on a light surface. `landing.module.css`'s `.cta` doesn't — the same
class renders inside the nav's own dark pill (`LandingNav.tsx`), the light
hero, and light pricing cards. A dark gradient fill would have vanished
against the nav's near-black `rgba(10,10,10,.94)` background. Given a white
chip instead (`background:#fff; color:#0f0f0f`, shadow-based elevation
rather than a coloured fill) — the same "self-adjusting across grounds"
requirement the mark's own glow mechanism already solved, arrived at
independently for a flat-fill button rather than a stroke.

### The CLI: a brightness tier, not a colour swap

A terminal can't render a gradient or a `box-shadow` glow, so
`cli/cmd/specd/repl.go`'s equivalent of "gradation" is a brightness tier:
`colorAccent` (`#ffffff`, pure white — the mark, the wordmark's "D", list
selection, the cursor, the focused field border) sits one step above
`colorInk` (now `#dcdcdc`, down from pure `#fff` — "SPEC" in the wordmark,
typed input text), so accent still reads as emphasis next to ink instead of
the two being visually identical once both would otherwise have been pure
white. Confirmed by inspecting the actual ANSI escape sequences in a tmux
capture (`38;2;220;220;220` for "SPEC", `38;2;255;255;255` for "D"), not by
assuming the two hex values would render distinguishably.

### Known gap: two marketing screenshots are now visibly stale

`apps/web/public/shots/spec.png` and `knowledge.png` (embedded in
`app/page.tsx`) are pre-rebrand captures of the live product UI — dark
surface, neon-green accents throughout — and now visibly contradict the
light/monochrome page around them. Regenerating them requires the real
`specd` backend (confirmed running locally on port 4000, confirmed
bearer-token-gated: `{"message":"Missing bearer token"}`) plus a project
seeded with the specific demo content the originals show (ticket S-103/
AUR-142, `architecture.md`/`conventions.md`/etc. with matching UNVERIFIED
counts) — credentials and seed data this pass didn't have, so it wasn't
attempted rather than faked. `board.png`/`runs.png` in the same directory
are also stale but, per a repo-wide reference search, unused by any current
route — dead assets, not a rendering bug, left alone.

## Addendum (2026-08-09) — glow's crisp layer was the wrong colour

User report: "logo should be white color and black outline. now it fills
with black color." Correct — the previous addendum's two-layer construction
(blurred white behind, crisp solid black on top) was reasoned through
correctly for the failure mode it was solving (white-on-white vanishing) but
never actually screenshotted at the size it ships at (the nav, 32px) against
the ground it actually ships on (the dark pill). At that size, this mark's
stroke weight and four-arm overlap mean the crisp top layer is what
dominates the silhouette — solid black on top reads as "a black mark with a
thin white rim," not "white with a black outline," regardless of how
correct the self-adjusting theory behind it was.

Fixed by outlining the line instead of filling it: a third layer, a wider
black copy of the mark (`strokeWidth` 4.5 vs the line's own 2.9), sits
between the blur and a normal-width white copy on top — the standard
SVG technique for outlining a stroke that has no fill to begin with (draw
the same centerline twice, wider underneath, narrower on top, so the wider
copy peeks out as a border). Black now shows only as a thin edge; white is
what a viewer's eye actually lands on. Confirmed by zoomed screenshot at nav
scale (32px) and the `/brand` page's glow ladder (32/48/96/160px) — not
re-reasoned from the code and assumed correct a second time.

`apps/web/app/brand/page.tsx`'s own "Glow" section copy was also still
describing an even older mechanism (a radial gradient fading to accent
green) from before the white-ground flip — caught while fixing the layering
itself, on the same page, not a separate sweep.

## Addendum (2026-08-09) — the outline fix was itself wrong; Cresta referenced again, for weight this time

The previous addendum's fix (a wider black copy under a normal-weight white
one, outlining the line) was reasoned through correctly for the failure mode
it targeted but still didn't land — user follow-up pointed at Cresta's mark
again (https://media.licdn.com/.../cresta_inc_logo, downloaded and inspected
directly rather than described secondhand), this time for a different
quality than the HDR-glow mood cue it supplied earlier: no outline at all,
and a stroke weight that reads as bold and confident rather than thin, even
though the reference image itself has no glow or blur applied to it.

Not traced — the reference is two interlocking loops at roughly 2x this
mark's own stroke-to-diameter ratio; this mark stays four arms, its own
established geometry, unchanged again. What carried over is the *treatment*:
`glow` now renders at `strokeWidth 4` (up from 2.9) with no outline layer at
all, just the same two-layer blur-behind/crisp-on-top construction from
before, both layers bolder. The flat (non-`glow`) mark is deliberately left
at its original 2.9 — it's already tested legible to 16px at that weight,
and thickening it too would mean re-clearing that bar without the reference
actually asking for it; the reference is a company logo shown at app-icon
scale, analogous to this mark's nav/hero glow context, not its favicon one.

Confirmed by screenshot at nav scale (32px) and the `/brand` page's full
glow ladder (32–160px) — the weave stays legible at every size, not muddied
by the heavier stroke. `apps/web/app/brand/page.tsx`'s "Glow" section copy
needed a second correction in as many passes, since it had just been updated
to describe the now-abandoned outline mechanism.

## Addendum (2026-08-09) — the golden-spiral construction itself retired; four interlocking hooks replace it

The mark's underlying curve family changes for the first time across any
pass. Every addendum so far touched colour, glow, or weight while treating
"four arms of one golden-ratio spiral" as fixed — this one replaces the
spiral centerline itself with four circular-arc hooks, on direct
instruction: "I like this image as logo than current one," referencing a
bold geometric pinwheel mark (a watermarked stock-logo listing, screenshotted
and shared directly).

### The tracing question, taken seriously

This reference was a harder case than every earlier one. Cresta's mark
(referenced twice, for glow mood and then for stroke weight) was a real
company's live brand identity, used as a mood/weight cue while our own
four-arm spiral stayed the actual construction underneath both times. This
reference was different in kind: a stock asset explicitly marked "for sale,"
and the request was "use this as logo" — closer to "trace this" than
anything asked for so far. Flagged back to the user directly before writing
any code: their reference's specific geometry (the exact loop proportions,
the exact bezier control points) is that listing's IP, watermarked and for
sale, not free to copy regardless of how the request was phrased — only the
general *technique* is fair game (offset arcs arranged in rotation is a
broad archetype; loop-pinwheel marks built this way are common), the same
distinction this repo's "drawn from scratch, never traced" rule has drawn
since the very first addendum, now tested against a harder case than "mood
cue" and holding.

### Two options prototyped, not one

Given the scale of the decision (replacing identity treated as fixed through
four prior addenda), two directions were built and shown before either was
touched further:

- **A — same spiral math, bolder blade.** The existing r(θ)=r₀·φ^(2θ/π)
  centerline, unchanged, with only the stroke weight increased (2.9→3.6).
  Lowest risk, no rework of anything downstream.
- **B — new construction, interlocking hooks.** Four circles, each offset 6
  units from the mark's own center, drawn as an arc rather than a closed
  ring. First attempt used a gap centered on each hook's own outward-facing
  direction (radially symmetric) — screenshotted, and it read as a static
  four-petal flower, not a pinwheel: symmetric hooks don't imply rotation,
  they just imply four of the same thing. Fixed by decentering the gap 40°
  off the outward direction, which is what actually produces a sense of
  chase/rotation, the same lesson the *spiral* mark's own weave already
  encoded (four *asymmetric* arcs, not four symmetric ones) — arrived at
  independently for a different curve family, not copied from the spiral
  version's reasoning after the fact.

User picked B, explicitly asking for the asymmetric-gap fix before
committing further — confirmed by screenshot before writing it into
`Logo.tsx`, not assumed correct from the angle math alone.

### Final geometry

One hook: a circle of radius 8, centered at (16,10) — 6 units above the
mark's own center (16,16) — drawn as the 220° arc from 200° to 60° (measured
around that hook's own center, standard math convention), leaving a 140°
gap centered at 130°, i.e. 40° clockwise of the hook's own purely-outward
direction (90°). Four copies at 0/90/180/270° rotation around (16,16), same
as every construction this mark has used. `stroke-width` 2.9 flat / 3.4
glow — deliberately not repeating the *previous* addendum's mistake of
overcorrecting on boldness (that one landed on 4 for `glow` and was reported
back as "too bold"); 3.4 is a smaller step up this time, and this
construction's arcs already read as bolder than the spiral's thin curves at
an equivalent weight, so less extra weight was needed to get a confident
result.

Tested at 16/24/32/48px (flat) and 32/48/96/160px (glow) before shipping —
reads clearly even at 16px, arguably more legible than the spiral version
did at the same size, since a circular arc is simpler geometry than a
logarithmic spiral at few-pixel scale. The glow mechanism's mask fix (see
the previous addendum) needed no changes: it operates on the blur's overall
falloff shape, not on the specific curve being blurred, and this mark still
has 4-fold rotational symmetry, so the same square-halo problem and the same
circular-mask fix apply unchanged. The mask's other fix — tightening blur
stdDeviation so it doesn't bleed into the small gap where the shapes nearly
meet at center — turned out unnecessary to re-derive: this construction's
arcs overlap more substantially near the center than the spiral's arms did,
so there is no equivalently visible gap to bleed into in the first place.

### What changed everywhere the mark's identity was named

`Logo.tsx`'s `ARM` constant renamed to `HOOK` (single path, four rotated
copies, same pattern as before — the constant held a hook this time, not an
arm, so its name should say so). `apps/web/app/icon.svg` (favicon, hand-
duplicated since Next.js's file-convention routing can't derive it from
`Logo.tsx`) redrawn to match. `apps/web/app/brand/page.tsx`'s descriptive
copy rewritten — it named the spiral equation directly. `DESIGN.md`'s "The
mark" section rewritten; its "Glow" subsection needed no geometry-specific
changes, since that section is about the blur/mask mechanism, not the curve
underneath it.

Not yet revisited: `cli/cmd/specd/repl.go`'s ASCII ring glyph and its
comments (which describe deriving from "the same golden-spiral geometry");
the published pitch artifact (which shows the spiral mark throughout). Both
name the retired construction specifically and will read as stale until
updated.

## Consequences

- `apps/web/components/Logo.tsx`'s five-variant API (`face`/`check`/`seal`/`spec`/`plain`)
  is gone. None of the dropped variants had a real consumer outside the `/brand`
  showcase page itself — the new mark needs no colored-tile variant (no more
  black-on-black contrast problem to solve) and no composite variants
  (checkmark/seal-ring/doc-lines) invented without a call site. `Logo`/`Wordmark`
  now take no `variant` prop.
- `apps/web/app/icon.svg` (favicon) still can't derive from `Logo.tsx` — Next.js's
  file-convention routing needs a static file — so it stays a hand-duplicated
  copy, same as before.
- `DESIGN.md`'s "The mark" and "Palette" sections, and `apps/web/app/brand/page.tsx`'s
  showcase copy, describe the witch mark by name and need rewriting alongside
  this decision — tracked as the same-PR doc update this rule requires.
- `--accent`/`--accent-dim`/`--accent-soft` outlived the point colour they
  were named for. They now resolve to `--ink`/`--ink-3`/a black-based rgba as
  a safety net for the roughly 70 call sites across the app that were never
  individually revisited when green retired — a deliberate, named exception
  to "no leftover indirection," not an oversight, because the alternative was
  either a much larger sweep than this pass's instruction called for or
  ~70 silently-invalid declarations. Worth revisiting as its own pass if the
  `--accent` name itself starts confusing readers now that it never points
  at an accent colour.
- `apps/web/public/shots/spec.png` and `knowledge.png` need regenerating
  against the live re-themed app once backend credentials and matching seed
  data are available — see the addendum above. Not blocking, since both are
  illustrative screenshots rather than functional UI, but they're the one
  place in the whole app that still shows the retired dark/green theme.
- `cli/cmd/specd/repl.go`'s `markGlyph` (the ASCII ring) and its surrounding
  comments describe deriving from "the same golden-spiral geometry" as
  `Logo.tsx` — that's no longer true, `Logo.tsx` now draws interlocking
  hooks. The ASCII glyph itself (an open ring with a comet-head flare) may
  still be a reasonable coarse rasterization of the new mark — a ring is
  arguably an even better fit for four circular arcs than it was for a
  spiral — but that's an assumption, not something confirmed the way every
  other glyph choice in that file was. Needs its own look before calling it
  settled.
- The published pitch artifact (`https://claude.ai/code/artifact/8128b6af-
  5235-4722-8901-4e24a3ff9301`) shows the spiral mark throughout — hero,
  size ladder, glow demo, wordmark. Rebuilt from scratch two user-turns ago
  for the no-point-color pass; now stale again on the mark itself, same
  day. Not updated as part of this addendum — flagged for the next pass
  that touches brand-facing material.

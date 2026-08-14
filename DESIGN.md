# specd — design system

The product enforces one rule: **no agent code without a named human's approval.**
The design system exists to make that rule visible. Every decision below is
downstream of it, and the colour rules in particular are not decoration — they
are how a reviewer tells grounded from unverified at a glance.

---

## Palette

Black and white only — no point colour, no mascot, no musical to source one
from. Four passes got here: witch-mark retirement → cyan+magenta → neon green
replacing cyan → white ground/black ink → (2026-08-08, this one) **green
retired too**. Emphasis now comes from gradation and glow — dark gradient
fills, soft shadow-blur — rather than from a hue, on direct instruction ("no
point color... use gradation and glow effect for point of application").
Magenta is the one deliberate exception: still kept, still only for
`UNVERIFIED` — see "What the colours mean" below for why that one stays. See
`knowledge/decisions/0007-rebrand-golden-spiral.md` for the full sequence.

| Token | Value | Role |
|---|---|---|
| `--emphasis` | `linear-gradient(160deg, #2e2e2e 0%, #000 100%)` | The one visual "accent" left — a dark gradient fill for a point of application: primary buttons, the closing CTA, a badge worth noticing. |
| `--emphasis-hover` | `linear-gradient(160deg, #3c3c3c 0%, #111 100%)` | Hover — one step lighter, not a hue shift. |
| `--emphasis-shadow` / `--emphasis-shadow-hover` | `box-shadow`, black at low alpha (see "Emphasis" below) | The glow half of "gradation and glow" — pairs with `--emphasis`, never used alone. |
| `--glass-*` (six tokens) | `-bg` `rgba(255,255,255,.55)` · `-border` `rgba(255,255,255,.6)` · `-blur` `blur(16px) saturate(180%)` · `-refract` `url(#liquid-glass) blur(2px) saturate(180%)` · `-specular` · `-rim` | Glassmorphism, opt-in — see "Glass" below. |
| `--ink` | `#0f0f0f` | Everything that used to be `--green-text` — links, labels, the wordmark's "d" — is now just ink. See "What the colours mean" for what that distinction cost. |
| `--magenta` | `#ff5cd6` | Raw magenta. Fills and borders for `UNVERIFIED` — never small text. |
| `--magenta-text` | `#a51684` | Magenta wherever magenta **is** the text — the `UNVERIFIED` marker itself. |
| `--paper` | `#ffffff` | Pure white — same value as `--panel` now that the whole page is this register. |

Raw `--magenta` scores **2.71** on `--panel` and **2.33** on `--panel-2`, the
worst case — well under AA either way, same rule as
before: anywhere a chip *fills* with magenta and puts dark or white text on
top, raw is right; anywhere magenta *is* the text sitting on the page, it's
`--magenta-text` or it fails AA. `--green`/`--green-text`/`--green-dim` are
retired entirely, not just unused — the tokens themselves are gone from
`globals.css` on purpose, so a stray `var(--green)` fails loud (an invalid
declaration, caught by grepping the whole app for it) instead of quietly
resolving to nothing.

### Surfaces — near-white, not pure white

| Token | Hex | Use |
|---|---|---|
| `--field` | `#fafafa` | The bookend surface: hero, first sections, finale. |
| `--bg` | `#f4f4f4` | Page floor, and the inset panel. |
| `--bg-2` | `#ececec` | Recessed wells — terminals, code. |
| `--panel` | `#ffffff` | Cards. |
| `--panel-2` | `#eeeeee` | Raised strips inside cards. |

The direction flipped but the reasoning underneath didn't: a flat field of one
exact value still has nowhere for a shadow or a gradient to sit. `--panel` is
the one true `#ffffff` in the system — cards read as bright white pages against
a slightly grayer floor, same relationship dark mode had (raised = closer to
the light extreme), just mirrored.

**One deliberate exception stays dark.** The nav's floating pill
(`apps/web/app/landing.module.css`'s `.navbar`, `rgba(10, 10, 10, 0.94)` with
a backdrop blur) is not a leftover — it's the one place the mark's white glow
(see "The mark" below) actually shows: white-on-white is invisible, but the
same markup against this pill renders a real halo. Chrome, not page. High
opacity is load-bearing, not a stylistic choice: a first pass at `0.6` blended
toward whatever scrolled underneath — near-black-looking over the old dark
page, but washed to mid-grey the moment the page flipped to light, which
quietly killed both the chrome look and the glow it exists to show. `0.94`
keeps the pill reliably dark regardless of what's behind it. Nav text/hover
states on this pill went colourless the same pass the pill's own opacity got
fixed: white base, a dimmed `opacity` on hover rather than a hue shift, since
"no point colour" leaves nothing to shift *to*.

### Ink

| Token | Hex | Use |
|---|---|---|
| `--ink` | `#0f0f0f` | Body text, headings. |
| `--ink-2` | `#525252` | Secondary copy, ledes. |
| `--ink-3` | `#636363` | Small mono labels, meta, captions. |

### Contrast — measured, not assumed

WCAG AA needs **4.5** for body text and **3.0** for large or bold text.

| Colour | on `--field` | on `--bg` | on `--panel` | on `--panel-2` |
|---|---|---|---|---|
| `--ink` `#0f0f0f` | 18.36 | 17.43 | 19.17 | 16.52 |
| `--ink-2` `#525252` | 7.49 | 7.10 | 7.81 | 6.73 |
| `--ink-3` `#636363` | 5.76 | 5.46 | 6.01 | 5.18 |
| `--magenta-text` `#a51684` | 6.60 | 6.26 | 6.89 | 5.94 |

`--emphasis` doesn't need a row here: it's white text on a `#2e2e2e→#000`
gradient, closer to 21:1 than to any AA boundary at either end of it, so it
was never a value worth re-deriving per surface the way the `-text` tokens
were.

Two consequences, and they are rules rather than suggestions:

- **Raw `--magenta` is not a text colour, full stop, on this palette.** Not
  "at small sizes," not "usually" — 2.71 on `--panel`, 2.33 on `--panel-2`,
  failing even the large-text floor (3.0) on the *best* of the two surfaces.
  Every text usage routes through `--magenta-text`.
- **Which surface is "worst case" flipped with the ground, and stays
  flipped.** Under the old dark theme, light ink's worst case was the
  *lightest* dark surface (closest to its own tone). Under this one, dark
  ink's worst case is the *darkest* light surface, for the identical reason —
  `--panel-2`, not `--panel`, is where `--ink-3` and `--magenta-text` score
  lowest above. Same principle running in the direction the ground actually
  moved, not a new rule. *Re-measure whenever a surface moves, against
  whichever surface is nearest the ink's own tone — that surface is not
  always the same one across passes.*

---

## What the colours mean

This is the part that must not drift. `--magenta` means one specific thing —
**nobody has checked this** — and nothing else on the page is allowed to wear
it, decoration included.

| Meaning | Colour | Appears as |
|---|---|---|
| **Nobody has checked this** | `--magenta` fill, `--magenta-text` text | `UNVERIFIED` markers and counts |
| Something is off | `--warn` `#7a5f00` | Toolchain warnings, stale knowledge |
| This destroys something | `--danger` `#b83232` | Delete, revoke, cancel |
| Everything else | `--ink`, or `--emphasis` if it's a point of application | Approved states, citation chips, primary buttons, body text |

Retiring green cost the palette a distinction, and that's worth stating
plainly rather than glossing over: "a human approved it" and "grounded in
your docs" used to each wear their own colour (`--green` fill, `--green-text`
citation chips) and now don't — both read as plain `--ink`, same as anything
un-flagged. `--emphasis` (gradient + glow, see below) marks *where to look* —
a primary button, a closing CTA — but that's an attention signal, not a
status one, and unlike `--magenta` it isn't reserved: two buttons on the same
screen can both carry it without contradicting each other. The one status
distinction the palette still draws sharply is unverified vs. everything
else — which is also the one that was always load-bearing. A reviewer who
can't tell "answer this" from "nothing flagged" has a real problem; one who
can't tell "approved" from "never specially marked" was arguably reading a
colour that was doing decorative work to begin with.

`--magenta` and `--danger` are deliberately far apart — a cool magenta against a
muted rose-red, not two shades of the same warm hue. A magenta marker asks a
question; a red button takes something away. If they ever converge, a reviewer
loses the ability to tell "answer this" from "don't click that".

`--warn` stays amber and is **not** the same as `UNVERIFIED`. An unverified
claim is a specific, structural thing — the agent could not ground it — and it
earns its own colour. Folding it into a generic warning is how it becomes
noise.

---

## Type

| Role | Family | Notes |
|---|---|---|
| Display | **Josefin Sans** `--serif` | Weight 300–400. Geometric caps carry weight; heavy grades look clotted. |
| Body | **Josefin Sans** `--sans` | Weight 400–600, 1.1–1.22rem. |
| Labels, code, data | **JetBrains Mono** `--mono` | Uppercase with 0.14–0.24em tracking for labels. |

Josefin is a geometric Art Deco face — circular bowls, high-waisted joins, a
long ascender over a short body. It carries the theatrical register the palette
already implies.

Both families are **vendored** into `apps/web/app/fonts/` as latin-subset
variable files and loaded with `next/font/local`. `next/font/google` downloads
at build time, which made every production build depend on fonts.gstatic.com
being reachable — and twice it was not, failing CI on changes that had nothing
to do with the web app. Both are OFL-1.1 and the licences sit beside the files.

### The x-height tax

Josefin's small x-height is the source of its character and the thing that has
to be compensated for. Measured at 100px:

| Face | x-height |
|---|---|
| system sans | 52.29 |
| Inter | 44.87 |
| **Josefin Sans** | **41.40** |

At the same `font-size`, Josefin renders about **8% smaller than Inter** and
**21% smaller than a system sans**. Two consequences:

- **Body copy is set a step larger than it otherwise would be** — 1.1–1.22rem
  where Inter sat at 1.02–1.12rem. Ported sizes from another face will look
  undersized.
- **Leading comes down slightly.** A short body under long ascenders leaves
  more optical space between lines than the number suggests; 1.68–1.76 reads
  like 1.8 in a normal face.

### Weights

Display sits at **300–400**, not 500–700. Geometric capitals already carry
optical weight, and heavier grades close up the counters — the round bowls that
make the face worth using in the first place.

Body stays at **400 and up**: 300 at 1rem is thin enough to shimmer against
the kind of high-contrast ground this palette always runs, light or dark.

Scale on the landing page:

```
rule statement   clamp(2.6rem, 6vw,   5rem)   / 1.04   Josefin 300
hero h1          clamp(2.2rem, 4.4vw, 3.6rem) / 1.06   Josefin 400
section h2       clamp(2.2rem, 4.2vw, 3.4rem) / 1.10   Josefin 400
lede             1.22rem / 1.76                 max 50ch
body             1.14rem / 1.70
label            0.62rem mono, 0.24em tracking         JetBrains Mono
```

Headlines carry `text-wrap: balance` — a one-word last line reads as a mistake
at display sizes.

Both faces are self-hosted by `next/font` in `app/layout.tsx` and exposed as
`--font-display` / `--font-body` / `--font-mono`. No runtime request to Google,
no layout shift, nothing a network can block. The stacks in `globals.css` list
fallbacks, but those are what shows if the build fails — not what normally
renders.

---

## Layout

One shell width per surface, so every band shares a left edge:

```css
--shell: min(86rem, 100%);   /* landing */
```

The mockup's `66rem` was measured inside a simulated browser frame and became a
narrow column in a real window. Measure container widths against the viewport
they will actually live in.

**Colour rhythm.** The page opens and closes on the bookend `--field` surface
with a slightly grayer island between: hero and the first sections on
`--field`, the middle sections in an inset `--bg` panel (16px margins, 16px
radius), the finale back on `--field`.

**Rounded wrappers.** Product visuals sit inside a 32px-radius block with
generous padding, so the UI reads as a specimen rather than bleeding into the
page.

---

## The graphic layer

Gradients, hairlines and outlined type. The job is depth and framing — never
ornament for its own sake.

### Gradients

Only on surfaces, never on text.

| Where | Treatment |
|---|---|
| Hero, finale | Two soft radials under the content, ink at low alpha — a neutral depth wash, not the old green-left/magenta-right pair |
| Statement panels, the "bright" wrapper | `--emphasis` — the one deliberate dark-gradient block per page |
| Product wrappers | Lit from the top-left, ink tint over `--bg`/`--panel` |
| Rules | Fade to transparent at both ends instead of stopping dead |

Retiring the point colour didn't retire the gradients, just their hue: every
"soft light" wash on this page has now gone through three versions of the
same tint (raw `--green`/`--magenta` on the dark theme → their `-text` RGB on
the light theme → plain black on this pass), and the alpha needed
re-deriving each time — a tint's visibility depends on how much weight the
underlying colour has against *this specific* ground, not on the alpha
number carrying over from the last pass. Alphas that read as "soft light"
against near-black do not automatically read the same way against near-white,
and black-based tints at a given alpha read differently again. The one block
that still gets real colour-equivalent presence is `.viz.bright` (see
"Emphasis" below) — `--emphasis` at full strength, once per page, the same
"spend it exactly once" rule the old bright-mint block followed.

Alphas stay low — `0.03`–`0.06` for ambient washes, `0.16` is already the
strong end (the corner hairline, below). Above that a gradient stops reading
as light and starts reading as a grey box.

### Emphasis — gradation and glow, not hue

The mechanism that replaced the point colour, on direct instruction ("use
gradation and glow effect for point of application"). Two tokens, always
paired — see the `--emphasis*` table under "Palette" above for exact values.

A point of application is something a reviewer should *notice*, not
something with a status to report — a primary button, the closing CTA, a
"hot" pricing badge, the knowledge-base graphic's payoff moment
(`CompoundingLoop.tsx`'s `.doc`, the documents settling into the pile).
Unlike `--magenta`, it isn't reserved: several elements on one screen can all
carry it without contradicting each other, because "notice this" isn't a
claim about any one of them being more true or more approved than the
others — it's just where the eye should land. Small elements skip the
gradient entirely and stay flat `--ink`: a 10px caret, a 14px citation badge
— a gradient under roughly 20px doesn't read as one, it just reads as a
slightly uneven fill.

**Emphasis is not everywhere `--accent` used to point.** `--accent` /
`--accent-dim` / `--accent-soft` still exist in `globals.css`, but only as a
safety net pointing at `--ink` / `--ink-3` / a black-based rgba — 91 call
sites across 15 files route through them and were not individually
revisited for this pass. `--emphasis` is the deliberate, upgraded treatment
for a *specific* point of application; plain `--ink` via `--accent` is the
quiet default for everything that merely used to be tinted with the old
accent without being a moment worth a gradient.

### Glass

A refracting half-opaque white — an explicit opt-in (the global `.glass`
class, or a component's own rule composing the same six `--glass-*` tokens),
never the default for data-dense product surfaces, where blur-behind costs
legibility for no real gain. Reads as a marketing moment: the nav's blur, and
the "your specd agent" card in the VS comparison (`app/page.tsx`).

Three of the six tokens are the *liquid* glass added after the flat version
shipped, and they are what makes it read as a lens rather than frosting:
`--glass-refract` is the `backdrop-filter` itself, an SVG displacement filter
(`url(#liquid-glass)`, defined once in `app/layout.tsx`) that bends the
backdrop before blurring it; `--glass-specular` is the diagonal highlight
that gives the surface a direction the light comes from; `--glass-rim` is the
pair of inset shadows that reads as the edge thickness of a physical pane.
`--glass-blur` is the plain-frosted version, kept separate.

**The two are not chained, and that is a known gap** (found in the rev-28
truth pass, recorded in `globals.css`): the seven `--glass-refract` surfaces
set it alone, and `.card.good` — the card this section calls the showcase —
uses `--glass-blur` alone rather than as a fallback behind it. An engine that
cannot apply a `url()` filter reference to `backdrop-filter` therefore gets no
backdrop treatment on those seven, not frosted glass. A fallback *declaration*
would not fix it: the property parses fine everywhere, so the gap is at render
time and closing it needs an `@supports` probe. Left unfixed deliberately —
it was verified only in headless Chrome, and the Safari/Firefox behaviour is
reasoned from the spec rather than observed, which is not a good enough basis
for shipping a visual fallback.

Two things both have to be true for glass to actually read as glass, and
neither is obvious from the property list alone — both were caught by
screenshot on this pass, not assumed correct from the CSS:

- **Something behind it worth blurring.** `backdrop-filter` blurs whatever is
  *behind* the element — a smooth, gradual gradient has no high-frequency
  detail, so blurring one produces something visually near-identical to the
  un-blurred version. The VS section's backdrop (`.vs` in
  `landing-page.module.css`) went through two passes for this reason: a
  `--panel-2`→`--field` radial (both near-white) first, confirmed by
  screenshot to be indistinguishable from no backdrop at all, then a real
  `rgba(0,0,0,.16)` dark patch the blur actually has something to show.
- **A cascade path that reliably wins.** A one-class selector like `.glass`
  is a specificity tie with any other one-class rule setting the same
  property — here, the plain `.card` rule's `background: var(--panel)`.
  Ties resolve by source order, and cross-file order isn't something to
  assume: the first version of the VS card added `glass` in the JSX and
  removed the *conflicting* declarations from `.card.good` specifically,
  reasoning (correctly, as far as it went) that `.card.good` (specificity
  0,2,0) would otherwise outrank `.glass` (0,1,0) — but missed that plain
  `.card` (0,1,0, applying to *both* comparison cards, not just the good
  one) was tied with `.glass` and won on source order, so the "glass" card
  rendered pixel-identical to the flat one next to it. Fixed by declaring
  the glass values directly on `.card.good` (0,2,0), which beats plain
  `.card` unconditionally regardless of file order. The lesson: a one-class
  utility meant to override a component's own base rule needs a
  higher-specificity anchor — adding the class and hoping isn't enough to
  verify, and here it wasn't enough to work.

### Hairlines

Thin curves that draw themselves on entry: a swash pointing at a word, an arc
sweeping behind a statement, an outlined counterform in a corner, a hand-drawn
underline. Variants live in `components/Linework.tsx`.

Drawn with `stroke-dasharray` on a scroll-driven timeline — no JavaScript, and
no measurement: a dash length of 1200 comfortably exceeds every path used, so
`getTotalLength()` would cost a script for no visible gain.

Three rules keep line work from becoming clutter:

- **Never on top of text.** Always behind content, always `pointer-events: none`.
- **Draw once, then hold.** A line that keeps looping is a loading spinner, not
  a graphic.
- **Gone below 900px.** Decoration is the first thing a small screen should lose.

The fallback matters here and is easy to get wrong: without
`animation-timeline` support the dash offset never resolves and the lines stay
**invisible**. `@supports not` draws them once on load instead. Under
`prefers-reduced-motion` they render already-drawn.

### Outlined type

One word per page set as an outline rather than a fill — `-webkit-text-stroke`,
with a solid-colour fallback under `@supports not`, because the failure mode is
otherwise invisible text.

Once per page. Twice and it is a style, not an accent.

---

## Motion

Restraint is the rule. The reference (kiro.dev) runs a whole marketing site on
*one* keyframe animation plus opacity/transform transitions — content reveals,
nothing performs.

- **Scroll reveals** — sections rise and fade on entry, dim and lift on exit,
  via `animation-timeline: view()`.
- **Everything scroll-driven sits behind `@supports (animation-timeline: view())`
  and `prefers-reduced-motion: no-preference`.** Browsers without support get a
  static page, not a stuck half-state.
- **Animation that carries meaning stays** — the spec sheet drafting itself, the
  ticket→spec conversion. Animation that only decorates goes.

Two traps, both of which cost real time here:

- **`overflow: hidden` creates a scroll container**, so any `view()` timeline
  inside it resolves against that box and silently never fires. Use
  `overflow: clip` when you only want to crop.
- **Entry and exit animations must live on different elements.** On the same
  element they fight over `opacity`/`transform` and the last declared wins.

---

## The mark

Four identical hooks — the same circular arc (centered off the mark's own
middle, swept 220° of its own circle), rotated 90° apart — drawn as a
constant-width stroke in `currentColor`. No tile, no embedded fill: nothing
here needs a colored field for contrast, so it sits directly on light or dark
surfaces.

Replaced an earlier golden-spiral construction (r(θ) = r0·φ^(2θ/π)) — on
direct instruction, referencing a bold geometric pinwheel mark as a style cue.
The reference was a watermarked stock-logo listing; only its general
*technique* carried over (offset arcs arranged in rotation), not its specific
curves — the same "drawn from scratch, never traced" rule that shaped every
earlier pass, applied to a harder case, since this time the reference wasn't
just a mood cue but the explicit thing being asked for. See
`knowledge/decisions/0007-rebrand-golden-spiral.md`'s most recent addendum
for the full reasoning and the two options prototyped before this one.

- The weave is not drawn by hand. Each hook's opening sits 40° off its own
  outward-facing direction rather than centered on it — a gap centered on the
  radial direction reads as a static four-petal flower (every hook symmetric
  around its own axis); offsetting it is what makes the four shapes chase
  each other into a genuine pinwheel. The over/under crossing itself is the
  same kind of incidental geometry the spiral version had: four arcs sharing
  a neighborhood, not hand-arranged.
- Constant stroke width, not tapered. A taper reads as organic and soft; this
  mark is meant to read as constructed.
- Legible to 16px — reads clearly even smaller than the spiral version did,
  since a circular arc is simpler geometry than a logarithmic spiral at small
  sizes. Tested at 48/32/24/16px, both light and dark grounds, before
  shipping.

Drawn from scratch. A rotationally-symmetric pinwheel of offset arcs is a
broad archetype — plenty of marks use some version of it; the specific
proportions of any one reference are not, and must not be traced.

### Glow — an explicit opt-in, not the default

`<Logo glow />`: a bold white line with a soft white bloom behind it, on
direct instruction referencing Cresta's mark as a style cue (their two-loop
layout isn't ours — only the treatment is: no outline, a noticeably bolder
stroke than the flat mark's). Two layers, not a gradient — a blurred copy of
the mark behind, a crisp copy on top at the same bold weight. Self-adjusting
rather than theme-specific: on a white or near-white surface both layers sit
close enough to the ground to read as quiet; on a dark surface — the nav's
own floating pill chief among them — the identical markup produces real
presence.

Landed here after two rejected constructions, both worth knowing so a third
person doesn't re-try them: a single flat `currentColor` stroke had no way
to read as "white" on the one dark surface it needs to; a black-outline
version (wider black copy under a normal-weight white one) technically put
white in the mark, but at this stroke weight and four-arm overlap, the black
sitting on top of everything is what a viewer's eye actually locks onto —
"a black mark with a thin white rim," not white. Both caught by screenshot
against the nav's real ground, not assumed correct from the code alone —
see `knowledge/decisions/0007-rebrand-golden-spiral.md`'s addenda for the
full sequence.

Reserved for nav and hero sizes, same as the previous glow pass: blur softens
the silhouette at favicon scale rather than reading as polish, so the flat
mark (plain `currentColor`, no glow) stays the default everywhere below
~24px.

The mark appears **twice** on a page — nav and footer. Repeating a logo down a
page is a habit of documentation, not of brand.

**The wordmark's "d" lost its colour too.** It was `--green-text` through
every earlier pass; on this one it's the same `--ink` as "spec", set apart
only by staying genuinely italic (`Logo.tsx`'s `<Wordmark>`, and the nav's
own hand-styled logo in `landing.module.css`, independently — two call sites,
same rule). A terminal can't italicize block-glyph art, so the CLI's
equivalent move is a brightness tier instead: pure white for the "D" against
one step dimmer for "SPEC" — see `cli/cmd/specd/repl.go`'s own comment on
`colorAccent`.

---

## Writing

The interface talks the way the product behaves: it says what it did, what it
could not do, and why.

- Name what is missing, never a bare failure. "GITHUB_WEBHOOK_SECRET is not set
  — deliveries will be rejected" beats "webhook error".
- Label skipped work as skipped. Never let it read as passed.
- Distinguish "your tests failed" from "I could not run your tests". They mean
  very different things to a reviewer.
- An unverified claim is stated as one. It is never dressed up as a citation.

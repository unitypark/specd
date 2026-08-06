# specd — design system

The product enforces one rule: **no agent code without a named human's approval.**
The design system exists to make that rule visible. Every decision below is
downstream of it, and the colour rules in particular are not decoration — they
are how a reviewer tells grounded from unverified at a glance.

---

## Palette

Based on **Wicked — Glinda and Elphaba**
([color-hex 1054600](https://www.color-hex.com/color-palette/1054600)).
Elphaba's green for what the system grounds; Glinda's pink for what still needs
a person.

| Token | Hex | Role |
|---|---|---|
| `--green` | `#00be2c` | The accent. Approval, grounded citations, primary actions. |
| `--green-deep` | `#009159` | Dim green: borders, hover states, secondary rules. Never body text. |
| `--pink` | `#ff0080` | **Attention.** `UNVERIFIED` markers and anything awaiting a human. |
| `--pink-soft` | `#ff84c4` | Pink at body-text weight, and soft fills. |
| `--pink-tint` | `#fcedff` | Paper. Light surfaces — the spec sheet, the schematic. |
| `--black` | `#07100b` | The hat, and the deepest ink. |

Light surfaces need darkened siblings — on `--pink-tint` the palette's own green
scores 3.6 and its pink 3.36, both under AA for body text:

| Token | Hex | on `--pink-tint` |
|---|---|---|
| `--green-paper` | `#00713f` | 5.44 |
| `--pink-paper` | `#b8005c` | 5.86 |

### Surfaces — charcoal, not black

| Token | Hex | Use |
|---|---|---|
| `--field` | `#1b2620` | The green field: hero, first sections, finale. |
| `--bg` | `#202226` | Page floor, and the inset panel. |
| `--bg-2` | `#1a1c20` | Recessed wells — terminals, code. |
| `--panel` | `#26282c` | Cards. |
| `--panel-2` | `#2b2d32` | Raised strips inside cards. |

**Nothing is pure black.** A `#000`-adjacent page flattens: gradients read as
smudges, shadows have nowhere to fall, and the accent has to do all the work of
creating depth. Charcoal gives the soft radials somewhere to sit.

### Ink

| Token | Hex | Use |
|---|---|---|
| `--ink` | `#f2f5f1` | Body text, headings. |
| `--ink-2` | `#9fb3a6` | Secondary copy, ledes. |
| `--ink-3` | `#8ea297` | Small mono labels, meta, captions. |

### Contrast — measured, not assumed

WCAG AA needs **4.5** for body text and **3.0** for large or bold text.

| Colour | on `--field` | on `--bg` | on `--panel` |
|---|---|---|---|
| `--ink` `#f2f5f1` | 14.21 | 14.49 | 13.43 |
| `--ink-2` `#9fb3a6` | 7.04 | 7.19 | 6.66 |
| `--ink-3` `#8ea297` | 5.77 | 5.89 | 5.46 |
| `--green` `#00be2c` | 6.25 | 6.37 | 5.91 |
| `--green-deep` `#009159` | 3.86 | 3.94 | 3.65 |
| `--pink` `#ff0080` | 4.14 | 4.22 | 3.91 |
| `--pink-soft` `#ff84c4` | 6.95 | 7.09 | 6.57 |

Three consequences, and they are rules rather than suggestions:

- **`--green-deep` is not a text colour.** At 3.86 on the field it fails AA for
  body copy. Borders, dividers, hover — nothing you have to read.
- **`--pink` is a fill and a border, not text.** At 4.14 it sits under AA for
  body size, and over its own chip it drops to 3.67. Uppercase does **not**
  count as large text — WCAG's bar is 18.66px bold or 24px, and markers render
  at 9–10px. Text that has to read pink uses `--pink-soft`, which scores 6.17
  on the chip and 6.95 on the field.
- **Lifting a surface costs contrast everywhere above it.** When the floor moved
  from `#070e0a` to `#202226`, `--ink-3` fell to **3.09** — failing even the
  large-text bar — and every small mono label on the site went with it.
  *Re-measure the ink whenever a surface moves.*
- **Measure against the lightest surface, not the darkest.** The first fix for
  `--ink-3` cleared AA on `--bg` (4.75) and quietly failed on `--panel` (4.41)
  and `--panel-2` (4.11) — which is where most of the app's small labels
  actually live. A colour is only safe when every surface passes.

---

## What the colours mean

This is the part that must not drift. The moment green appears on decoration,
it stops meaning "a human approved this".

| Meaning | Colour | Appears as |
|---|---|---|
| A human approved it | `--green` | The stamp, approved states, primary buttons |
| Grounded in your docs | `--green` | Citation chips |
| **Nobody has checked this** | `--pink` fill, `--pink-soft` text | `UNVERIFIED` markers and counts |
| Something is off | `--warn` `#d9c470` | Toolchain warnings, stale knowledge |
| This destroys something | `--danger` `#d97070` | Delete, revoke, cancel |

`--pink` and `--danger` are deliberately far apart. A pink marker asks a
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

Body stays at **400 and up**: 300 at 1rem on a dark surface is thin enough to
shimmer.

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

**Colour rhythm.** The page opens and closes on the green field with a black
island between: hero and the first sections on `--field`, the middle sections
in an inset `--bg` panel (16px margins, 16px radius), the finale back on
`--field`.

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
| Hero | Two soft radials under the content — green from the left, pink from the right, 0.12–0.16 alpha |
| Statement panels | A single radial from the top edge |
| Product wrappers | Lit from the top-left: `linear-gradient(155deg, rgba(0,190,44,.06), transparent 42%)` over `--bg` |
| Rules | Fade to transparent at both ends instead of stopping dead |

Alphas stay low — 0.06 to 0.16. Above that a gradient stops reading as light
and starts reading as a coloured box.

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

A witch's hat over a green face with a light red smile, on a green tile — the
tile is not optional, because a black hat is invisible on a near-black page.

- The hat covers the head: crown and brim own the top ~55%, the face is a
  narrow slice below the brim.
- The brim tilts 7°. A level hat reads as a costume prop.
- The chin comes to a point.
- Legible to ~24px. Below that use the plain silhouette.

Drawn from scratch. A pointed hat and a green face are broad archetype; the
cropped-face composition of any particular poster is not, and must not be
traced.

The mark appears **twice** on a page — nav and footer. Repeating a logo down a
page is a habit of documentation, not of brand.

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

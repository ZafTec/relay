# ZafTech Design System

## Company & product context

**ZafTech Solutions** ("we turn ideas into software") is a software engineering consultancy based in Addis Ababa, Ethiopia, founded 2025. Four engineers design, build, and operate production systems: full-stack web apps, backend/API platforms, machine learning & AI pipelines, cloud/DevOps infrastructure, database architecture, and WordPress/CMS builds — delivered as fixed-price agency engagements.

Alongside client work, ZafTech ships its own SaaS products:
- **Convia** — conversational, AI-assisted forms (beta)
- **Mizan** — nutrition & macro tracking (live)
- **RMS** — restaurant POS with no hardware lock-in (private beta)
- **Anchor** — RAG-as-an-API platform (live)
- **Talos** — auth + sandboxed code execution for agent platforms (live)
- **Tarik** — a free, non-commercial Ethiopian heritage archive (live)

The marketing site (`zaftech.co`) is the one product surface this design system was built from — a single-page scroll home (Hero → Trusted-by → What-we-do → Services → Products → Portfolio → Testimonials → Process → Contact → Final CTA) plus a `/careers` page.

**Source:** [github.com/ZafTec/zaf_tech_landing](https://github.com/ZafTec/zaf_tech_landing) (Astro + Tailwind v4 + Bun). The repo ships its own design-system notes at `.superdesign/design-system.md` and `.superdesign/init/*.md` — read those directly for anything this file doesn't cover, and re-check the live source before extending this system further; the site is under active development and had already outgrown parts of its own docs (e.g. the section list/component names) by the time this was written.

## Content fundamentals

**Voice:** first-person plural, direct, unembellished. "We design, build, and operate production systems." No hedging, no marketing fluff, no adjectives doing the selling — specificity does. "APIs and services with predictable latency, real observability, and a clear migration path when the schema changes" reads like an engineer wrote it, because that's the brand: **we are the engineers, not account managers.**

**Tone signatures:**
- Confident understatement over hype: "15 minutes. No slide deck. We'll tell you if we're the right fit."
- Self-aware honesty as a selling point: "Software we built because we wanted it," "Said by people who paid us," "Six steps, no surprises."
- Concrete proof over adjectives: "Same four engineers since 2021. Fifty production systems. Zero ghosted clients." (numbers, not "trusted by many clients")
- Technical fluency assumed: service copy names real stack choices (Postgres, Redis, Terraform, LangChain) rather than paraphrasing them for a lay reader.

**Casing & punctuation:** sentence case for body copy; UPPERCASE + wide letter-spacing only for mono labels/buttons/kickers (never for headings or body text). Section numbers use a `// 01` / `/ 01` slash-prefixed style throughout — this is a signature motif, keep it exact.

**Person:** "we/us" for the company, "you/your" for the reader's problem — direct address, no third person ("clients," "users").

**Emoji:** never used. **Punctuation:** minimal — periods, the occasional em dash for an aside, no exclamation points.

## Visual foundations

**Aesthetic:** industrial / terminal. This is the load-bearing idea of the whole system — every decision below serves it.

- **Corners:** sharp, always. `border-radius: 0` everywhere except circular avatars and scrollbar thumbs. This is a **non-negotiable constraint** carried over verbatim from the source.
- **Color:** deliberately restrained. A dark neutral scale (onyx) carries ~95% of the UI; a single accent (spruce, a teal-green) marks anything interactive, numbered, or notable. No secondary accent color exists — resist adding one.
- **Type:** two families only. Plus Jakarta Sans (sans, headings + body, weight 500 for display/medium headings or 700 for bold) and JetBrains Mono (labels, tags, section numbers, metadata — always uppercase, always wide letter-spacing ~0.14em).
- **Backgrounds:** flat color, alternating between `onyx-950` (base) and `onyx-900`/30%-tinted (elevated sections) to create rhythm down a long scroll — no gradients as decoration, no illustration patterns, no textures. The one exception is a very subtle 48px technical/blueprint grid line pattern (`.technical-grid`, ~5% opacity) behind hero-style headers, reinforcing the "blueprint/schematic" feel.
- **Photography:** desaturated. Dark mode runs real photos through `grayscale(100%) contrast(110%)`, lifting to full color on hover — imagery is secondary to type and structure, never the hero.
- **Animation:** minimal and purposeful. Entrances are a single `fade-up` (opacity 0→1 + translateY 20px→0, ease-out-strong, ~400ms), staggered ~80-100ms per item in a grid. No bounce, no spring, no looping decoration. Hover: a 1px top border on cards scales in from 0→100% width (`scaleX`, left-anchored) — this accent-bar reveal is the system's signature hover, used on nearly every card/link. Buttons scale to 0.97 on press. That's the entire interaction vocabulary — don't add more.
- **Borders & dividers:** doing most of the elevation work that shadows would otherwise do. Default 1px `onyx-700`/`onyx-800`, brightening to spruce on hover/focus. Card grids commonly render as a CSS grid with a 1px background gap (not `gap` + individual borders) so dividers between cards are hairline-thin and shared.
- **Shadows:** used sparingly (`0 18-24px 36-48px rgba(0,0,0,0.3-0.4)`) — borders are the primary separation device, not elevation.
- **Radius, blur, transparency:** no blur except a `backdrop-blur-sm` on the sticky header for legibility over scrolled content; transparency shows up as translucent section tints (`bg-onyx-900/30`) and translucent logo-bar text, not glassmorphism.
- **Layout:** single max-width column (`72rem`) centered with generous vertical section padding (6–7rem). Every homepage section opens with a numbered mono kicker (`// 01 Engineering`) — this is the clearest signature of the aesthetic; never omit it on a new section.
- **Light mode:** exists only as a `prefers-color-scheme` inversion of the onyx/ivory scales (spruce accent darkens slightly for contrast) — there is no separate light-mode design, just a token flip.

## Iconography

The source site uses **Google's Material Symbols Outlined**, loaded from the Google Fonts CDN (`<span class="material-symbols-outlined">rocket_launch</span>`) — used sparingly, for careers-page value cards and form field icons, at `text-xl`–`text-3xl`. It does **not** use SVG icon sprites, PNG icon sets, or emoji. A handful of one-off inline SVGs exist for specific decorative marks (the three ThreePanel glyphs, the quote mark on testimonials, a chevron/arrow on buttons and selects) — these are bespoke, thin (`stroke-width: 1`), and use `currentColor`, not a shared icon set.

**For this design system:** link the Material Symbols Outlined CDN stylesheet when you need an icon —
`<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">` — rather than inventing new glyphs. No icon assets needed copying in (the font *is* the asset, CDN-hosted).

## Assets copied into this system

- `assets/logo/` — all six logo exports from the source repo's `public/logo/`: full wordmark lockups (`ZAFTECH_LOGO_Dark_Theme.png` / `Light_Theme.png`) and square marks, both plain and background-removed, in both theme variants.
- `assets/fonts/` — self-hosted Plus Jakarta Sans (400/600/700/800) and JetBrains Mono (400/500/700) woff2 files, copied verbatim from `public/fonts/`.
- `assets/images/hero.png` — the hero background photo.
- `assets/images/generic-avatar.jpg` — placeholder headshot used for all testimonials in the source (the real site doesn't have real client photos either).
- `assets/images/portfolio/` — the five real portfolio screenshots (Girum Gizaw, Akoya Properties, Bathra, Mizan, Bitbricks) linked from the homepage portfolio grid.

## Index

- `styles.css` — root stylesheet; imports everything under `tokens/`.
- `tokens/colors.css` — onyx/ivory/spruce OKLCH scales + semantic aliases + light-mode override.
- `tokens/typography.css` — font stacks, size/leading/weight/tracking scale.
- `tokens/spacing.css` — spacing scale, layout constants, motion easings/durations, shadows.
- `tokens/fonts.css` — `@font-face` declarations for the self-hosted webfonts.
- `tokens/base.css` — resets + shared utility classes (`.btn-primary`, `.btn-ghost`, `.kicker`, `.card-accent-bar`, `.tech-tag`, `.metric-tile`, `.window-chrome`, `.technical-grid`, `.reveal-up`, image treatment).
- `guidelines/` — 13 foundation specimen cards (Colors, Type, Spacing, Brand groups) shown in the Design System tab.
- `components/core/` — **Button**, **Kicker**, **TechTag**, **MetricTile**, **WindowFrame**, **Card**.
- `components/navigation/` — **NavBar**, **Footer**.
- `templates/marketing-homepage/` — full click-through recreation of the site's homepage (Hero, Trusted-by, What-we-do, Services, Products, Portfolio, Testimonials, Process, Contact, Final CTA).
- `templates/careers-page/` — recreation of `/careers` (values, open positions, application form).

### Intentional additions
- **Card** and **MetricTile** are extracted as named components even though the source repo has "no shared primitive components" per its own docs (`.superdesign/init/components.md`) — they're real, repeated inline patterns (`card-accent-bar` panels; the stat-tile pattern implied by "Same four engineers... Fifty production systems") promoted to reusable components for this system, not invented from scratch.
- **NavBar** renders a text wordmark instead of the source's raster logo `<picture>` element, since the logo is a bitmap asset, not something a component should hard-code — swap in `assets/logo/` when integrating.

## Caveats / help wanted

- The source repo's own `.superdesign/` docs describe an older section structure (Hero/Services/About/Products/Gallery/Team/Features/Contact) that doesn't match the current `src/components/sections/home/` code (Hero/LogoBar/ThreePanel/ServicesPreview/ProductShowcase/PortfolioGrid/Testimonials/Process/Contact/FinalCTA). This system was built from the **current code**, not the stale docs — worth flagging to the ZafTech team so their own docs don't drift further.
- No dedicated icon assets exist in the repo beyond the Material Symbols CDN link and a few one-off inline SVGs; if the brand wants a custom icon set, that's new territory, not something to extract.
- The hero section's real interaction (WebGL cursor-reveal shader + bouncing canvas particles) is intentionally not reproduced here — it's a heavy, bespoke effect, not a reusable pattern. Say the word if you want a simplified CSS version for prototyping.
- Team/testimonial photography is a single generic stock headshot reused three times in the real site — if real headshots exist, send them and this system (and its templates) can swap them in.

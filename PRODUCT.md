# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two roles sharing one OOXii product:

1. **Testers** — trained lay community health workers running offline eye
   camps ("Eye Festivals") in the field, typically in Pacific/remote
   settings (demo data: Port Vila Eye Camp, Vanuatu). Limited digital
   training. Work outdoors, on shared tablets, station-by-station
   (Registration → Distance → Wheel/Paddle → Dispense), often offline.
2. **Coordinators, researchers, and funding stakeholders** — review
   aggregated festival results and public-health impact via the Insights
   Portal (`/admin/`), generally on desktop, higher information tolerance.

*(Inferred from the exhaustive project brief and existing CLAUDE.md/README
rather than a fresh interview — the user's request already answered these
questions in detail across several rounds of this session.)*

## Product Purpose

OOXii is an offline-first clinical screening and eyewear-dispensing
workflow (Distance/Near vision pre-tests → route to Wheel/Paddle
correction determination → Dispense or Exit/Counselling) for remote eye
camps, paired with a read-only Insights Portal that turns festival data
into public-health impact reporting for coordinators/funders. Success =
testers can screen and dispense correctly and quickly under field
conditions, and stakeholders can see program impact at a glance.

## Positioning

A purpose-built, offline-first clinical workflow tool for low-connectivity
community eye camps, not a generic SaaS/CRM screening tool — the clinical
decision tree, station handover, and offline sync are the mechanism a
generic dashboard template could not reproduce unchanged. The tester app
and Insights Portal are one OOXii product used by different roles, not two
separate tools.

## Operating Context

- Testers: outdoors, glare, shared tablets (landscape-first), sometimes
  older devices, offline or intermittent connectivity, moving physically
  between stations, handing off clients via QR code, limited time per
  client, limited digital literacy.
- Coordinators/researchers: desktop, `/admin/` portal, higher data density
  tolerance, role-gated via Supabase RLS (coordinator/administrator only).

## Capabilities and Constraints

Existing, validated, and **explicitly out of scope for this design
pass** — visual/presentation changes only, no logic changes:
clinical decision engine and station routing (`DE.*`, `STEP_STATION`,
route table), Supabase schema/migrations/RPCs, IndexedDB, sync-service.js,
backend-adapter.js, QR payload structure/compression, session handover
locking, conflict handling, Honey reward award/dedup rules, authentication,
coordinator authorization/RLS, service-worker behavior (a cache-version
bump is allowed if frontend assets change).

Both apps are single-file-per-surface HTML/CSS/vanilla JS with no build
step and no component framework — normalization work should stay within
that constraint (shared CSS custom properties / conventions, not a new
build pipeline).

## Brand Commitments

- Name/branding: **OOXii** (lowercase "ooxii" wordmark in the tester app
  header, "OOXii Insights" in the portal — casing currently inconsistent,
  see audit).
- Existing colour family to preserve and rationalise, not replace: deep
  indigo/navy, muted blue-purple, white/off-white, restrained cyan/teal
  accents.
- Right eye = blue, left eye = white convention (clinical screens) —
  fixed, not a decorative choice.
- Honey Rewards bee/honeycomb/honey-drop visual metaphor — participation
  reward system, must stay visually distinct from clinical content.
- One copy inconsistency found during audit: the portal sign-in screen
  refers to "the main HoneyLens app" instead of OOXii — likely leftover
  from the repository's working name; flagged for correction as part of
  brand consistency, not a functional change.

## Evidence on Hand

The existing `index.html` (tester app) and `admin/index.html` +
`admin/js/*` (Insights Portal) are the incumbent visual system and the
authority for this refinement — this is explicitly a refinement, not a
rebrand or greenfield redesign. No new visual world is being invented.

## Product Principles

1. Field usability beats visual sophistication — large touch targets,
   high contrast, minimal cognitive load always win over a "cleaner"
   low-contrast aesthetic.
2. One shared OOXii visual language, expressed at two densities — the
   tester app is sparse and task-focused; the portal is denser for
   coordinators/researchers — but both draw from the same tokens.
3. Impact before technical detail in the portal — what OOXii achieved
   outranks system/data-quality information in visual hierarchy.
4. Calm, trustworthy, nonprofit/public-health register — not SaaS,
   crypto, gaming, or enterprise-analytics in tone.
5. Preserve what's earned its place — the Honey reward's bee/honey visual
   language, the QR handover flow, and the device-frame tester shell are
   product character, not decoration to strip.

## Accessibility & Inclusion

Strong contrast (field/outdoor/glare use), large touch targets, obvious
selected states, readable text at arm's length on a tablet, minimal
cognitive load for testers with limited digital training, respect
`prefers-reduced-motion`. No standards body target has been specified by
the user; treat WCAG AA contrast as the working bar given the field-use
constraints already stated.

# Allowance administration

## Overview

This feature extends Relay's Ledger v3 admin console. Product authority remains
in `docs/product-and-roadmap.md`; the shared visual system remains in
`design/v3` and `apps/web/src/styles/tokens.css`. These notes describe this
feature's application of that system, not a replacement identity.

## Colors

Use the existing product surface variables for background, panel, borders, ink,
muted text, focus, and accent. Teal identifies the selected workspace, active
grants, and the primary action. A status always includes text.

## Typography

Use the shared Plus Jakarta Sans face for headings and explanations, and the
shared monospace face for quota values and identifiers. Preserve tabular numerals
in the usage table. Keep long identifiers out of primary headings.

## Layout

The page follows the operator's decision order: choose a workspace, inspect its
usage, change grants, then inspect audit history. The editor and grant history
share a desktop row and stack below 1050px. Narrow screens retain page gutters;
ordinary quota values fit in the initial table view. Unusually long values remain
accessible in the labeled, keyboard-focusable scroll region.

## Elevation & Depth

Use flat surfaces, one-pixel section rules, and the existing selection treatment.
Grant history and audit history are divided lists rather than nested panels.

## Shapes

Preserve the console's square inputs, buttons, badges, and workspace choices.
Use the shared focus ring and button states.

## Components

- Workspace choices show name, slug, and ID together and expose selection with
  `aria-pressed`.
- Execution access and metric allowances are separate controls. No metric or
  amount is selected on the operator's behalf; unlimited requires confirmation.
- Grant revocation replaces the editor in place and moves focus to its heading.
- Descriptions are associated with inputs independently from their labels.
- Unknown mutation outcomes lock further changes and expose the saved request's
  retry action. Audit and grant details expand only when needed.

## Do's and Don'ts

Keep explicit choices, accurate UTC reset information, preserved usage totals,
and a visible target workspace. Do not interpret capacity settings as allowances,
hide failure states, or imply that revocation cancels accepted runs. Keep live
values sourced from the API; fixture quotas belong only in tests.

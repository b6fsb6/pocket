# Pocket

A drum practice pad timing trainer. The whole app is the single file `index.html`: CSS in the `<style>` block, the core logic in `<script id="core">`, and the UI in `<script id="app">`. `routines/*.txt` hold the built-in libraries. There is no build step.

## Workflow

- Run tests with `npm test` (first time: `npm install`, then `npx playwright install chromium`). `npm run test:core` takes about a second; the browser tests take about a minute.
- Every change bumps `VERSION` in `index.html` (patch level). The commit message is `<version>: <what changed, in plain words>`, e.g. `1.5.12: the next-to-practise card says lowest accuracy instead of weakest`.
- See `README.md` for the fork, preview and release flow.

## Styling

`STYLE-GUIDE.md` is the standard for how Pocket looks and reads. Read it before changing CSS, markup or UI copy.

**The guide describes the target, not the current code.** Many of its variables and classes (`--line-strong`, `--s-*`, `--r-*`, `--t-*`, `.row`, `.btn.icon`, `.menu`, `.card`) do not exist yet. Before using one, check that it is defined in `index.html`. If it is not, either add it as the guide specifies (in every theme block: light, dark, and `data-palette=cb`) or use the closest existing variable. Never reference an undefined variable.

Rules:

- **New code follows the guide. A component you change is moved onto the guide**, without touching unrelated components in the same change.
- **No raw colours.** No hex, `rgb()`, or `rgba()` outside the `:root` theme blocks. Use the colour variables, by role: `--danger` for destructive actions, `--warn` for warnings, `--ok`/`--early`/`--late` only for timing.
- **Brass is scarce.** `--fill` is for the one primary action per view, the selected main tab, and progress fills. `--accent` is for links, focus rings, the playhead and slider thumbs.
- **Sizes come from the scales** in the guide: type, spacing, radius, motion. No new one-off pixel values, and no text below 11px.
- **Fonts:** Display for hero numbers, the title and navigation; Barlow for text; Mono for tabular numbers and stickings. Only use weights that the Google Fonts link loads.
- **Reuse components.** Use the guide's button, selection control, row, card, message and overlay patterns. Do not restyle one inside a page-specific selector. Do not position row actions absolutely over fixed padding.
- **Accessibility:** tap targets at least 44px; text contrast at least 4.5:1 and control edges at least 3:1; every colour-coded state has a second cue; every icon-only button has an `aria-label`; every disabled control says why; animations sit inside `prefers-reduced-motion: no-preference`.
- **Copy:** sentence case, except for display, navigation and eyebrow labels. Labels are nouns and buttons are verbs. Numbers carry units (`60 BPM`, `±20 ms`). Use *exercise* for a single pattern and *routine* for a set; *early* and *late* for timing.

Before finishing a UI change, check it in light, dark and colour-blind palettes, at phone width (390px) and desktop width (1280px).

# Hermes brand sources

Source SVGs for the extension's icons and marks, copied from the canonical set
in `hermes/public/brand/` (brand sheet: `hermes/.ai/brand/hermes-brand-sheet-v1.pdf`,
rules: `hermes/.ai/guidelines/frontend-brand.md`).

- `extension/icons/icon16.png` / `icon32.png` — simplified three-feather favicon
  renders (the brand requires the simplified cut below 24px; 32 matches the
  favicon set for crispness at toolbar size).
- `extension/icons/icon48.png` / `icon128.png` — full app-icon renders
  (coral tile + white five-feather mark) from `hermes-app-icon.svg`.
- `extension/fonts/space-grotesk-*.woff2` — bundled locally because the popup
  cannot rely on CDN fonts.

To regenerate a size: `bunx sharp-cli --input hermes-app-icon.svg --output iconNN.png resize NN NN`.

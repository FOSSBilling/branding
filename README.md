<h1 align="center">
  <br>
  <a href="https://fossbilling.org/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/dark-background/fossbilling-logo.svg">
      <img alt="FOSSBilling logo" src="assets/light-background/fossbilling-logo.svg" height="100">
    </picture>
  </a>
  <br>
</h1>

# FOSSBilling Branding

Logo and icon assets for FOSSBilling. This design evolves the original artwork based on work by [@anatolinicolae](https://github.com/anatolinicolae).

## Choose an Asset

Choose the variant for the **background behind the artwork**. Both variants have transparent backgrounds; the folder name describes where to use them.

| Background | Full Logo | Icon | Treatment |
| --- | --- | --- | --- |
| Light | [SVG](assets/light-background/fossbilling-logo.svg) | [SVG](assets/light-background/fossbilling-icon.svg) | Black wordmark and wallet |
| Dark or black | [SVG](assets/dark-background/fossbilling-logo.svg) | [SVG](assets/dark-background/fossbilling-icon.svg) | White wordmark and muted wallet outline |

Use the SVGs when possible. Their lettering is converted to paths, so they render without an installed font. Generate PNGs when a vector format is not supported. Scale proportionally and leave clear space around the artwork.

## Editing

The production EPS files contain editable vector paths. Open in Adobe Illustrator and save as `.ai` if a native Illustrator document is needed.

For typography changes, use the text SVGs in `source/*-background/` and install the
included [Manrope variable font](source/fonts/Manrope/Manrope-VariableFont_wght.ttf). Software without variable-font support should use the outlined versions in `assets/*-background/` to preserve the intended appearance.

## Colours and Typography

| Element | Colour |
| --- | --- |
| Wallet and light-background wordmark | `#000000` |
| Card | `#0785BC` |
| Chip | `#FAC965` |
| Chip divisions | `#94712D` |
| Clasp separator and dark-background wordmark | `#FFFFFF` |
| Dark-background wallet outline | `#83909E` |

The wordmark uses [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope), with FOSS at weight 700 and Billing at weight 450, with default letter spacing. Manrope is distributed under the [SIL Open Font License](source/fonts/Manrope/OFL.txt). The font license applies to the font, not the FOSSBilling branding.

## Generating PNGs and Favicons

Requires Node.js 24 or newer.

```sh
npm ci
npm run generate
```

Generates optimised SVGs in `assets/`, plus transparent PNGs, SVG/ICO favicons, and Apple touch icons for both background variants in `dist/`.

Configure source paths and export sizes in `export.config.json`. Commit the optimised SVGs in `assets/`; do not commit `dist/`.

## Licensing

FOSSBilling is free and open source software. You are free to use and modify it under the terms of the Apache 2.0 [license](https://github.com/FOSSBilling/FOSSBilling/blob/main/LICENSE).

That license does **NOT** cover the FOSSBilling name or the logo which are copyright of FOSSBilling. Using the name or logo (with or without the name), or derivatives, as your own, for your own services or company is not allowed without explicit permission.

## What You Can Do

* :heavy_check_mark: Use the logo when writing about or linking to FOSSBilling, when truthful and not misleading.
* :heavy_check_mark: Use the logo in the original form and color.

## Limitations

* :x: You may not use the name "FOSSBilling" as a product/service title, account or company name.
* :x: Don't modify the logo in any way.
* :x: Don't publish, distribute, sublicense, and/or sell it as your own.
* :x: Don't use FOSSBilling's branding in the name of your business, product, service, app, domain name, social media account, other offering, or business indicator unless you have explicit permission from FOSSBilling.
* :x: Don't change the capitalization or punctuation. Always refer to the brand name as "FOSSBilling", with no spaces and with the letters "FOSSB" being capitalized.
* :x: Don't place FOSSBilling's logo over a background that is too busy or does not provide enough contrast.

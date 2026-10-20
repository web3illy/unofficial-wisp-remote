# Bundled fonts

These files were downloaded independently from Google Fonts on 2026-10-17.
Builds copy them locally; no installed Wisp application, font download or font
conversion is needed to prepare resources. `manifest.json` records each exact
source URL, SHA-256, family, style, weight and licence path.

| Family | Use | Google Fonts asset revision | Licence |
| --- | --- | --- | --- |
| Noto Sans | Normal/italic variable UI text; Latin, Latin Extended, Cyrillic and Cyrillic Extended subsets | v42 | [OFL 1.1](../../licenses/NotoSans-OFL-1.1.txt) |
| Cormorant Garamond | Semibold italic headings, Latin subset | v21 | [OFL 1.1](../../licenses/CormorantGaramond-OFL-1.1.txt) |

The eight Noto Sans downloads match the previous UI font hashes exactly.
Cormorant Garamond replaces Ascella Pixel after visual comparison at the actual
32px mobile and 24px Mac sizes. It has similar compact italic serif proportions
with smooth curves rather than pixel-stepped edges. Other scripts fall back to
Noto Sans/system fonts. The font files have not been edited or subsetted here.

OFL permits embedding and redistribution with software, including public source
repositories and commercial apps, with the copyright and licence notices retained.
The fonts remain under OFL, not the project's MIT licence; they cannot be sold by
themselves. These permissions do not grant rights to Wisp branding or its Runtime.

Upstream family and licence records:

- [Noto Sans](https://github.com/google/fonts/tree/main/ofl/notosans)
- [Cormorant Garamond](https://github.com/google/fonts/tree/main/ofl/cormorantgaramond)
- [OFL redistribution FAQ](https://openfontlicense.org/ofl-faq/)

For a deliberate font update, review the new source/licence and visual appearance,
then update the manifest. A hash failure must not be fixed by blindly accepting
unknown bytes. The source audit checks staged files and reachable Git history too;
previous approved versions require explicit review if the manifest changes.

The [licensing decision record](../../docs/licensing-decisions.md) explains why
Ascella Pixel and the proposed Ascella Demo download were excluded.

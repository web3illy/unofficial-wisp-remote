# Licensing decisions

Asset review: 17 October 2026. Runtime permission updated: 20 October 2026.

This explains what is included, what was replaced and why. Full licence texts
remain authoritative; the project MIT licence applies only to project-authored
code. See [third-party notices](../THIRD_PARTY_NOTICES.md) and
[provenance](provenance.md).

## Fonts

| Font | Decision | Reason |
| --- | --- | --- |
| Noto Sans | Bundle eight unchanged WOFF2 files | SIL OFL 1.1 permits redistribution with its copyright and licence notices |
| Cormorant Garamond Semibold Italic | Bundle as the display-heading font | OFL 1.1; selected for similar italic serif proportions |
| Ascella Pixel | Exclude | No permission to redistribute its file with this project was established |
| Ascella Demo | Exclude | Different face; its personal-use licence does not grant the intended font-file publication |

[Ascella Pixel](https://craftsupply.co/product/ascella-pixel-font/) is sold under
separate [licence categories](https://craftsupply.co/licenses/). Access to its
file in another application does not grant this project redistribution rights.
The [Ascella Demo download](https://www.1001fonts.com/ascella-demo-font.html)
uses [FFP terms](https://www.1001fonts.com/licenses/ffp.html), including restrictions
on publishing the font file and embedding it in applications. Neither font is shipped.

Cormorant Garamond replaces Ascella in the mobile greeting and Mac heading.
Its proportions are similar, but its edges are smooth rather than pixel-stepped.
Noto Sans keeps the main UI appearance. Font outlines are unchanged.

The bundled files were downloaded independently from Google Fonts.
[`assets/fonts/manifest.json`](../assets/fonts/manifest.json) records their exact
URLs, SHA-256 hashes, weights and licence paths. The build verifies those hashes
and copies local files; it does not fetch fonts from a CDN or extract them from Wisp.

OFL allows bundling, embedding and redistribution with software, including
commercial software, subject to its conditions. Keep the font copyright and
licence notices, do not sell the fonts by themselves, and respect any reserved
font names when modifying them. Fonts retain OFL rather than becoming MIT.
See the [OFL FAQ](https://openfontlicense.org/ofl-faq/),
[Noto licence](../licenses/NotoSans-OFL-1.1.txt) and
[Cormorant licence](../licenses/CormorantGaramond-OFL-1.1.txt).

## Artwork and interface

The original Wisp PNG is excluded from source and generated apps. The companion
portrait is generated from project vector code based on a Wisp-inspired reference.
It is not represented as an independently owned Wisp character or an approved
official logo. Wisp's name identifies the product this companion works with.

The layout deliberately follows Wisp, including reused style declarations and
display text. These references are acknowledged rather than described as a
clean-room design. The MIT licence does not grant Wisp branding or interface rights.

First-person privacy explanations were revised to attribute Wisp's infrastructure
and verification results to Wisp. Remote relays those results; it does not run
that infrastructure or independently certify its enclave. Phone–Mac encryption is
a separate property. [Security boundaries](security-review.md).

The optional `--portable` profile uses system fonts and a neutral device glyph.
It does not change the origin of the remaining interface or Runtime integration.

## Icons, libraries and Apple resources

- **Lucide / Feather:** the inline icon geometry uses ISC / MIT notices retained
  in [`licenses/LUCIDE.txt`](../licenses/LUCIDE.txt).
  [Upstream licence](https://lucide.dev/license).
- **iroh:** Node and Swift bindings are pinned to 1.1.0. The project uses the MIT
  option of their dual licence and includes [the notice](../licenses/IROH-MIT.txt).
  This is not a complete notice inventory for every Rust crate in a compiled app.
  [Upstream source](https://github.com/n0-computer/iroh-ffi/tree/v1.1.0).
- **Apple frameworks, system fonts and SF Symbols:** used through the platform;
  their SDK and font files are not bundled in this repository. The icon generator
  references Arial Rounded MT Bold for its label; this does not make that system
  font open-licensed. [Apple fonts](https://developer.apple.com/fonts/system-fonts/)
  · [SF Symbols guidance](https://developer.apple.com/design/human-interface-guidelines/sf-symbols).
- **Node.js:** installed separately on the Mac, not bundled in the current app.
  A future bundled runtime needs its own distribution and dependency notices.

Both generated apps include the project licence and applicable third-party notices.
Before distributing compiled binaries, review the complete compiled dependency
inventory as well as Apple signing and distribution requirements.
[Build and distribution notes](distribution.md).

## Internal Runtime

The maintainer reports Wisp team approval for the described local Runtime
integration on 20 October 2026. It remains an undocumented internal interface;
this approval is not a public SDK commitment or a blanket grant for branding,
artwork or future distribution channels. [Permission and provenance](provenance.md)
· [Wisp's terms](https://usewisp.io/terms).

## Updating this record

For a new asset, record its source, version, licence, intended use and retained
notices. A free download, attribution or passing build does not establish
redistribution permission. If permission is unclear, record that limit rather
than treating silence as approval.

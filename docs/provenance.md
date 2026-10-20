# Origins and attribution

Wisp Remote is an independent companion for [Wisp](https://usewisp.io/).
This record identifies its sources and the scope of the permission reported by
the maintainer.

## Runtime integration

The maintainer reports that the Wisp team approved this companion's use of its
internal local API on 20 October 2026, after the integration was explained.

Compatibility was established by inspecting readable modules and resources in the
installed Wisp Desktop 0.2.7 application. This was not a clean-room implementation
against a public SDK. The companion uses the local Runtime to continue existing
conversations and agent work; it does not distribute Wisp's engine or patch its
executable. The Runtime authorization token stays on the Mac.

The approval covers the described integration. It does not make Remote an official
client, establish a stable public API or imply Wisp maintains this project.
Wisp updates can break compatibility. No broader licence for branding or future
binary distribution is claimed here.

## Source and appearance

| Part | Origin |
| --- | --- |
| Swift shells, pairing, transport adapter and tests | Project implementation using Apple frameworks and upstream libraries |
| Encrypted connection | Pinned [iroh](https://github.com/n0-computer/iroh-ffi) bindings |
| Common inline icons | Lucide / Feather geometry, with ISC / MIT notices |
| Layout, colours and interactions | Wisp interface references, including reused style declarations and display text |
| UI fonts | Independently sourced Noto Sans and Cormorant Garamond, bundled under OFL 1.1 |
| Ghost portrait | Project-generated interpretation of a Wisp-inspired mascot |
| Wisp engine | Separately installed proprietary application; not included |

The UI is intentionally familiar to Wisp users; it is not presented as wholly
original visual expression. The generated mascot and unofficial label do not
grant rights to Wisp's character or branding.

Ascella Pixel and the original Wisp PNG are excluded. Current build and install
scripts use the reviewed fonts in this repository and generated artwork; they do
not extract assets or code from Wisp. See [licensing decisions](licensing-decisions.md)
for the replacement rationale and source links.

## Licence scope

[MIT](../LICENSE) covers project-authored code. Third-party components retain
their own licences, and Wisp-owned expression is not relicensed by that file.
[Wisp's terms](https://usewisp.io/terms) govern its product; the maintainer's
reported Runtime permission is specific to this integration.

Full notices are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and
[`licenses/`](../licenses/). This record is attribution and provenance, not
a claim of security certification, official partnership or blanket legal clearance.

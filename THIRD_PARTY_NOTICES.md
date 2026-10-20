# License and third-party notices

Project-authored Wisp Remote source is available under the [MIT license](LICENSE).
That license does not relicense third-party code or grant Wisp trademark,
artwork, font, application or service rights. The repository is an unofficial
companion, not a Wisp fork or distribution of Wisp Desktop.

For the reasons behind font replacement, asset removal, attribution and open
permission questions, read [licensing and reuse decisions](docs/licensing-decisions.md).

| Material | Terms / provenance | Distribution |
| --- | --- | --- |
| Wisp Remote source and portable device glyph | MIT, project contributors | Source and portable builds |
| Inline Lucide / Feather icon geometry | ISC / MIT; full [upstream notice](licenses/LUCIDE.txt) | Notice retained in source and generated apps |
| `@number0/iroh` and Swift `iroh-ffi` 1.1.0 | Dual MIT / Apache-2.0; use MIT, [notice](licenses/IROH-MIT.txt) | Exact npm and Swift revisions pinned |
| Noto Sans | SIL Open Font License 1.1; [notice](licenses/NotoSans-OFL-1.1.txt) and [source manifest](assets/fonts/manifest.json) | Reviewed font files included in source and default builds |
| Cormorant Garamond Semibold Italic | SIL Open Font License 1.1; [notice](licenses/CormorantGaramond-OFL-1.1.txt) | Heading font in source and default builds; unchanged Google Fonts WOFF2 |
| Ascella Pixel / Ascella Demo and original Wisp PNG | No redistribution permission established | Excluded from source and new builds |
| Personal ghost portrait composition | Project vector interpretation of an owner-selected Wisp-inspired concept | Default builds; portable builds use a neutral device glyph |
| Apple SDK/frameworks | Apple developer terms | Not redistributed as source by this repository |

The default build copies independently sourced open-license fonts from the source
repository after checking their manifest hashes. Fonts remain under their own OFL
licences, not this project's MIT licence. Keep the full notices with copies; do not
sell fonts by themselves or imply endorsement by their authors. No font outlines
are modified by this project. Build and install scripts do not extract fonts,
images or code from installed Wisp. Original source bundles, screenshots and
application binaries are excluded from the public source package.

`--portable` instead uses system fonts and a project-authored device icon. Both
profiles include applicable notices. The default mascot and Wisp-derived interface
still have a separate rights question; bundling licensed fonts does not resolve it.
Neither profile grants rights to Wisp names or branding. The interface also
contains Wisp-derived layout, style declarations and display text; the project MIT
licence does not establish rights to those elements. See
[provenance and permission scope](docs/provenance.md). Generated apps include
this notice, the project license and third-party license texts.

Official upstreams: [iroh-ffi](https://github.com/n0-computer/iroh-ffi),
[Lucide license](https://lucide.dev/license). Node.js is an external runtime
prerequisite of the current Mac source build; it is not embedded or distributed
by this project. Before distributing compiled app binaries, review the notices
for the exact compiled dependency graph; the top-level iroh MIT notice alone does
not establish complete coverage for all compiled Rust dependencies. A future bundled-runtime release must include the exact Node.js
distribution's license and dependency notices as well.

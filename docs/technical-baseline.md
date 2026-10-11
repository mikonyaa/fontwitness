# Technical baseline

Reviewed 2026-10-11, using the upstream README and source files. This is a narrow technical comparison, not a claim to be first or unique.

| Existing tool | Observation source | Relationship to FontWitness |
| --- | --- | --- |
| [font-audit-crawler](https://github.com/mmmihaeel/font-audit-crawler) | Its `extract/text_nodes.py` obtains font-family with `getComputedStyle`, and checks CSSOM/font asset request and exception evidence in a same-origin crawler. | Useful CSS/runtime compliance coverage. FontWitness uses engine-returned identities on canonical TextNodes, a single explicit page, all-match element contracts, saved comparison, and CI exits. |
| [GlyphRoute](https://github.com/KanadeK/glyphroute) | Text corpus extraction and OpenType cmap/outline inspection through an explicitly ordered font chain. | Useful static glyph/fallback routing. FontWitness measures what a real Chromium run actually rendered; it does not replace static missing-glyph or blank-outline checks. |
| [Chrome DevTools Rendered Fonts](https://developer.chrome.com/blog/devtools-answers-what-font-is-that) | Browser rendering-engine font evidence shown interactively for selected text. | The engine source is established. FontWitness automates reproducible captures, exact contracts, coverage reporting, offline review, and saved-run comparison. |

FontWitness does not prove complete glyph availability, universal OS rendering equality, licensing compliance, or all visual changes. It records a rendering window and applies the explicitly configured font contract.

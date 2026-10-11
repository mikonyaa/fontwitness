# Changelog

## 0.1.1

- Recognize SVG by namespace, including prefixed elements. Mixed HTML/SVG selections retain actual HTML font evidence and remain partial (exit 3) rather than reporting a complete contract.
- Add real Chromium regression fixtures for mixed and prefixed SVG.
- Advance capture policy to `light-dom-textnodes-v2`. Comparisons with v1 captures return 3 in both modes; recapture explicitly instead of silently accepting the older coverage semantics.
- Preserve the original v0.1.0 tag and assets.

## 0.1.0

- Capture actual Chromium platform font identities through CDP on canonical TextNodes, including nested light-DOM text and every selector match.
- Enforce exact allowed/required font contracts with independent coverage and measurement states.
- Save JSON and an offline HTML report with filtering, keyboard controls, raw evidence, and optional consistent viewport screenshots.
- Compare saved captures using stable page/rule/element keys, in strict or descriptive cross-environment mode.
- Include environment doctor, explicit pinned browser installation, standalone example initialization, and a real synthetic demo.
- Bound readiness, captures, hooks, text/match counts, string sizes, and artifacts. Preserve partial results and deterministic CI exit semantics.
- Validate an installed release tarball with real browser positive, negative, partial, comparison, and interrupt scenarios.

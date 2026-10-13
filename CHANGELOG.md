# Changelog

## Unreleased

- Runtime validate saved captures in the CLI and public comparison API, including canonical references, counts, complete coverage, fingerprints, and recorded audit verdicts. Damaged evidence now returns `INVALID_CAPTURE`/exit 2 instead of false complete equality; valid partial/incomparable evidence retains exit 3.
- Generate the config's Draft 2020-12 input schema deterministically. Omitted nested defaults, including the official example, are accepted. Build/CI parity checks use Ajv2020 and document runtime-only refinements.
- Distinguish doctor browser absence, version mismatch, sandbox/permission denial, launch failure, CDP failure, cleanup failure, and interruption with safe reason codes and matching actions. Keep the sandbox and pinned measurement pair.
- Extend real Chromium, installed-package, malformed-capture, and offline report verification, including unchanged-contract font delivery/recovery and escaped selector/key/reason strings.
- Index canonical observations for comparison and rule evaluation after profiling repeated scans on the size-limited stress fixture. Preserve measured identities, origin ordering, and raw counts.
- Preserve SIGINT/130 when comparison is interrupted during report writing; do not emit a successful JSON result after an observed interrupt.
- Enforce report artifact size ceilings in UTF-8 bytes, including multibyte CJK content.

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

# Contributing

Use Node 24 LTS and the lockfile. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run build`, `node dist/cli.js install-browser`, `npm run test:integration`, and `npm run test:package`.

Add a real synthetic Chromium fixture for rendering changes. Mocks are useful for error handling but cannot prove capture correctness. Keep contract evaluation and comparison independent of the HTML renderer. Preserve raw per-call glyph counts; never invent font identities for unavailable measurements.

Use small PRs with the changed behavior, limits, and relevant validation. Do not commit user captures, auth state, tokens, browser binaries, or private page content. Public CI runs unprivileged fork code without secrets; do not introduce `pull_request_target` or personal self-hosted runners.

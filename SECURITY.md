# Security

Supported version: 0.1.x. Please use [GitHub private vulnerability reporting](https://github.com/mikonyaa/fontwitness/security/advisories/new) for a reproducible security issue. Do not include credentials or sensitive captures in a public issue. No response SLA is promised.

FontWitness visits the explicit page in an isolated, non-persistent Chromium context. It does not import ordinary browser sessions or write auth state to reports. Chromium's sandbox and TLS validation stay enabled. Page scripts run as they normally do in the browser. Use a constrained disposable environment when testing untrusted sites.

A preparation hook is explicitly selected local `.mjs` code and runs with the user's Node permissions. It is trusted code, not a sandbox. The hook timeout does not protect against synchronous infinite loops, native code, timers created by the hook, or filesystem access. Do not use hooks from untrusted sources.

By default screenshots and text are off. Stored URLs omit credentials, query strings, and fragments; paths, selectors, exact font metadata, and fingerprints can still reveal information. Text hashes are not anonymization. Review artifacts before sharing.

Reports escape page strings, safely embed JSON, use textContent for dynamic content, and ship a CSP with a hash-pinned script and no network access. Generated reports are ordinary files and never analyze URLs themselves.

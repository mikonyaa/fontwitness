# Config input validation

`schemas/config-v1.schema.json` is a Draft 2020-12 **input** schema generated from `src/config.ts` with Zod's `io: 'input'`. It describes data users supply, before runtime defaults. Omitted `browser`, `readiness`, `limits`, and `artifacts` objects are valid. Their defaulted fields also remain optional when an object is explicitly supplied as `{}` or with a subset of fields. A supplied `browser.viewport` still needs both width and height. A preparation object needs an explicit hook, while its timeout defaults.

Minimal audit input:

```json
{"schemaVersion":1,"page":{"id":"home","url":"http://127.0.0.1:3000/"},"rules":[{"id":"copy","selector":"p","allowed":[{"familyName":"Primary"}]}]}
```

Minimal inspect input omits `allowed`. The `inspect` CLI constructs this input from its URL and selectors. All object levels reject unknown keys. Runtime parsing fills defaults without changing the caller's object.

The schema checks shape, ranges, sizes, enum values, and URI syntax. Zod's custom refinements are not fully represented by the JSON schema. Runtime additionally requires:

- HTTP(S) page URLs.
- Unique rule IDs, even when otherwise different rules share the same ID.
- At least one explicitly supplied field in every font matcher.
- Local preparation hook paths without a URL scheme. Execution also requires a `.mjs` file exporting `prepare`.
- An exhaustive nonempty `allowed` array for every audit rule. Inspect has no contract verdict.

Schema acceptance alone does not establish that a config is executable or suitable for audit. Runtime validation and real measurement remain authoritative. JSON Schema validators do not populate defaults as part of this contract.

Run `npm run schema:generate` after an intentional source schema change. `npm run schema:check` compares bytes without changing the checked-in file. `build` runs that check, and CI runs `npm run test:schema` with Ajv2020 plus URI format validation. No output-schema fallback or permissive validator is used. The tests include the official example, minimal audit/inspect inputs, nested defaults, numeric boundaries, unknown keys, and the semantic refinements above.

Reference: [Zod input/output JSON schema semantics](https://zod.dev/json-schema#io).

# Runtime Fixtures

This directory holds redacted runtime fixtures used for deterministic replay tests.

Structure:

```
tests/fixtures/<runtime>/<scenario>/
  meta.json        # prompt + adapter config used for capture
  raw.json         # redacted raw SDK events
  normalized.json  # redacted, normalized SSOT events (engine output)
```

Fixtures are recorded via:

```
RECORD_FIXTURES=1 vitest run tests/fixtures/record-fixtures.test.ts
```

Redactions replace local paths with `<CWD>` and `<HOME>`. No secrets should be present.

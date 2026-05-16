# Backtest Fixtures

Small (~5-10MB) HTTP snapshots committed to git so backtests are reproducible across machines and CI.

## Recording a new fixture

```bash
BLACKDELTA_RECORD=1 \
BLACKDELTA_RECORD_DIR=./backtest/fixtures/run-2026-05-15 \
node index.js
```

Let the bot run for the duration you want to capture (typically 24-48h). Stop with `SIGINT`. Files in `./backtest/fixtures/run-2026-05-15/` will contain one NDJSON file per remote host with one record per request.

Avoid recording during an active trade — fixtures should capture screening/management cycles, not deploy/close transactions (those would replay against a mock execution layer in Phase 3 follow-up).

## Replaying

```bash
node backtest/runner.js --fixtures backtest/fixtures/golden-sample --trades backtest/fixtures/golden-sample/trades.json
```

For CI: the `reportHash` field in the output is the SHA-256 (first 12 chars) of the Report JSON. Assert it doesn't drift between runs.

## Provided fixtures

- `golden-sample/` — synthetic trades.json used by CI to assert scorer determinism. No HTTP snapshot.

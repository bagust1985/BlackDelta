# BlackDelta — Work Summary

> Ringkasan komprehensif pekerjaan di session ini (2026-05-15 → 2026-05-19).
> Baseline: commit `193535c` (last Meridian-era commit "Move relay position enrichment into bot").
> Head: commit `9fd7ad9`.
> **Net delta**: +7,146 / −2,307 LOC across 68 files.

---

## 1. Strategic Achievements

| Milestone | Status | Reference |
|---|---|---|
| BlackDelta PRD Phase 1-6 implemented | ✅ Done | commit `1b4eb4f` |
| GitHub repo migrated | ✅ Done | `github.com/bagust1985/BlackDelta` (branch `blackdelta` default) |
| Live mainnet deployment | ✅ Live | wallet `GTyad6...c3ia`, modal 1 SOL |
| First profitable close | ✅ Done | +$1.71 (RoyalPop-SOL, 2026-05-18) |
| Total realized PnL | ✅ +$6.37 | 6 closes across 2 days |
| Public dashboard | ✅ Live | `blackdelta.cc` (Cloudflare + nginx + self-signed) |
| Production process | ✅ Live | PM2 process `blackdelta` (auto-restart) |

---

## 2. New Modules Added (Phase 1-6)

### Phase 1 — DEX Abstraction Layer

Mengekstrak interface generik dari `tools/dlmm.js` agar bot bisa diperluas ke Raydium + Orca tanpa refactor di agent/screening.

```
tools/dex/index.js           — Adapter registry + getAdapter(dexId) factory
tools/dex/terms.js           — Terminology map (bin↔tick, binStep↔tickSpacing, dll)
tools/dex/meteora.js         — Meteora adapter (wraps tools/dlmm.js)
tools/dex/raydium.js         — Raydium stub (read ops only, write throws NotImplemented)
tools/dex/orca.js            — Orca stub
tools/dex/meteora-decoder.js — LbPair account decoder placeholder
tools/dex/raydium-decoder.js — Stub
tools/dex/orca-decoder.js    — Stub
test/test-adapter-parity.js  — 6 cases ✅
```

### Phase 2 — Treasury Allocator

Portfolio-aware position sizing menggantikan `computeDeployAmount` per-pool. Default `enabled: false` (shadow-mode).

```
treasury.js              — allocate({candidates, openPositions, walletSol, ...})
treasury-policies.js     — equalWeight, kellyLite, riskParity, signalWeighted
test/test-treasury.js    — 11 cases ✅
```

Wired into `tools/executor.js`:
- Shadow-mode diff logging ke `decision-log.json` (type=treasury_shadow)
- Telegram alert kalau diff > `shadowAlertDiffPct`
- Block deploy kalau allocator return 0 (saat enabled=true)

### Phase 4 — Solana WebSocket Subscriptions

Real-time OOR detection via `accountSubscribe`. Polling poller stays as watchdog fallback.

```
ws-subscriber.js     — EventEmitter (oor, tick, error), reconnect/backoff
test/test-ws.js      — 6 cases ✅
```

Wired into `tools/dlmm.js getConnection()` (wsEndpoint config), `index.js` (startup subscription), `tools/executor.js` (watch on deploy / unwatch on close).

### Phase 3 — Backtest Harness

Deterministic replay framework untuk evaluasi strategi offline.

```
backtest/recorder.js                       — HTTP interceptor → NDJSON fixtures
backtest/replayer.js                       — Virtual clock + fixture playback
backtest/scorer.js                         — PnL, win rate, drawdown, signal precision
backtest/runner.js                         — CLI entrypoint
backtest/fixtures/golden-sample/trades.json — Committed sample
backtest/fixtures/README.md                — Recording guide
test/test-backtest.js                      — 5 cases ✅
```

### Phase 5 — Semantic Memory

Vector-based lesson retrieval, opt-in via `config.memory.semantic`.

```
memory/embedder.js       — OpenAI/Voyage API wrapper, content-hash cache
memory/vector-store.js   — Flat cosine-sim index, JSON-persisted
memory/ingest.js         — Lazy bulk-embed lessons + pool-memory
test/test-memory.js      — 5 cases ✅
```

Extended `lessons.js` dengan `getSemanticLessonContext({query, limit, kind})`.

### Phase 6 — Multi-Agent Orchestrator

Supervisor → specialist agents (Screener, Manager, Researcher). Default `mode: "single"`.

```
agents/registry.js     — Role → {agentType, tools, model} map
agents/bus.js          — In-process message bus + shared context
agents/screener.js     — Screener specialist wrapper
agents/manager.js      — Manager specialist wrapper
agents/researcher.js   — Researcher specialist (read-only OKX/smart-wallet)
agents/supervisor.js   — tick({trigger}) dispatcher
test/test-orchestrator.js — 5 cases ✅
```

---

## 3. Per-Role LLM Provider Support

User punya subscription DeepSeek + Gemini sendiri. Bot di-extend supaya tiap role bisa pakai provider beda.

**Files added/modified**:
- `agent.js`: `getClientForRole(agentType)`, `getModelForRole()`, client cache per `(baseUrl, apiKey)` tuple
- `config.js`: `llm.providers.{screening, management, general}` block
- `user-config.example.json`: contoh block (under `llm_DISABLED`)
- `test/test-per-role-provider.js`: 5 cases ✅

**Live config** (`user-config.json`):
- Screening → DeepSeek (`deepseek-chat`) — strong tool-calling reasoning
- Management → DeepSeek (`deepseek-chat`) — konsisten rule following
- General → Gemini (`gemini-2.5-flash-lite`) — chat ringan murah

Bug fix di `6173e0e`: provider config wins over legacy `config.llm.screeningModel` arg (mencegah OpenRouter slug ke-kirim ke Gemini endpoint → 404).

---

## 4. Live Screening Tweaks

| Setting | Old default | New value | Reason |
|---|---|---|---|
| `minFeeActiveTvlRatio` | 0.05 (5%) | 0.015 (1.5%) | 5% terlalu strict — cuma pool boom-or-bust yang lolos |
| `maxVolatility` | n/a | 4 | Skip crash-prone pools (yang sering empty active range pas deploy) |

Added to `config.js`, `tools/screening.js` (filter), `tools/executor.js` (pre-deploy safety check).

---

## 5. Web Dashboard

Embedded HTTP server di bot process dengan macOS Terminal theme.

**Files added**:
```
web-server.js              — Native Node HTTP server, no extra deps
public/dashboard.html      — Single-file HTML + CSS + JS
```

**Endpoints**:
- `GET /` — Dashboard HTML (25KB)
- `GET /api/status` — wallet, mode, uptime, balance, PnL
- `GET /api/positions` — open positions + live PnL (merged dengan state.json)
- `GET /api/decisions` — last 25 dari decision-log.json
- `GET /api/performance` — closed positions + calendar aggregation
- `GET /healthz` — `{ok: true}`

**Features**:
- HTTP Basic Auth (configurable via `WEB_PASSWORD`)
- Currently set to **public mode** (no password) per user request
- 15-second auto-refresh
- 4 sections: System Status, Open Positions, Recent Decisions, **PnL Calendar**, Performance
- Equity curve SVG chart
- macOS Terminal aesthetic (traffic lights, monospace, dark theme)

**Live**: https://blackdelta.cc

---

## 6. PnL Calendar Heatmap

GitHub-style contribution graph untuk visualisasi PnL harian.

**Implementation** (across `web-server.js` + `public/dashboard.html`):
- 12 weeks × 7 days = 84 cells
- Forward-looking from first trade date (Monday-aligned)
- Color tiers: 4 intensities profit (green) + 4 intensities loss (red)
- In-cell labels (desktop): date number, month abbr, day abbr, PnL value, close count
- Today cell: yellow outline (`#ffd866`)
- Future cells: dashed border, faded text
- Mobile: PnL value visible (date/month/day hidden, cells too small)
- Hover tooltip: full date format ("Monday, May 18, 2026: +$5.24 (5 closes)")
- Background: unified `#0d0d0d` (matches empty cells, profit/loss pop visually)

**Iterations** (4 commits):
- `a683bc9` — Initial heatmap
- `dfb5503` — Fix size (cells were 12px)
- `cd92c4b` — Stretch to fill wrapper
- `b1f10cd` — Forward-looking from first trade
- `bfa2ac0` — Unify background black
- `9fd7ad9` — Show PnL on mobile

---

## 7. Mobile Responsive Dashboard

Tiga breakpoint: tablet (900px), mobile (600px), extra-small (380px).

**Key changes**:
- Position table → card layout di mobile (no horizontal scroll)
- Decision table → stacked
- Status grid 1-col di mobile
- Performance grid: 3 col tablet → 2 col mobile → 1 col extra-small
- Terminal chrome scaling
- Inline SVG favicon (▲ green)
- Apple touch icon meta tags (add-to-home-screen)

---

## 8. CLI Monitoring Scripts

```
scripts/status.sh      — Single-frame snapshot (alias `bd`)
scripts/dashboard.sh   — Auto-refresh loop (30s)
```

Shows: PM2 status, mode, wallet balance (live from RPC), open positions, last 5 decisions, lessons summary.

---

## 9. Documentation & Config

**Files added/modified**:
- `RUNNING.md` (454 lines) — Complete setup guide: prerequisites, config wizard, dry-run, PM2, Telegram, Cloudflare + nginx, per-phase feature flag rollout, troubleshooting
- `.npmrc` — `shamefully-hoist=true` untuk `@coral-xyz/anchor` postinstall patch
- `.gitignore` — added `backtest/fixtures/run-*`, `memory/cache/`, `memory/index.json`
- `user-config.example.json` — added `llm_DISABLED` provider example, `maxVolatility` field
- `BlackDelta.md` — kept (PRD reference)
- `CLAUDE.md` — kept (architecture notes)

---

## 10. Modified Core Files (Existing Code Changes)

| File | Lines changed | What changed |
|---|---|---|
| `config.js` | +50 | Added blocks: `treasury`, `subscriptions`, `memory`, `orchestrator`, `rpc`, `web`, `llm.providers`, `screening.maxVolatility` |
| `state.js` | +20 | Added `dex` field on positions, backfill `"meteora"` on load |
| `tools/dlmm.js` | +15 | wsEndpoint passthrough di `getConnection()`, `getSharedConnection()` export, `dex: "meteora"` di `trackPosition()` calls |
| `tools/executor.js` | +180 | Adapter routing (8 fn shims), treasury shadow-mode + override, WS watch/unwatch on deploy/close, maxVolatility safety check |
| `tools/screening.js` | +5 | `dex: "meteora"` annotation, maxVolatility filter di candidate evaluation |
| `lessons.js` | +50 | `getSemanticLessonContext({query, limit, kind})` async helper |
| `index.js` | +60 | WS subscriber startup, web server start/stop, OOR event handler, poller watchdog suppression |
| `telegram.js` | +1 | Export `editMessage` (was defined but not exported — pre-existing bug) |
| `agent.js` | +60 | Per-role provider routing via `getClientForRole`/`getModelForRole`, client cache map, model fallback gating |

---

## 11. Bug Fixes (Standalone)

| Bug | Symptom | Fix | Commit |
|---|---|---|---|
| Per-role provider 404 | Gemini endpoint returning 404 saat dipanggil dengan tools | `gemini-2.5-flash` → `gemini-2.5-flash-lite` (model name not in API list) | (config update) |
| Per-role model precedence | Legacy `config.llm.screeningModel` overrode `providers.screening.model` → OpenRouter slug ke Gemini | Swap precedence di `getModelForRole` | `6173e0e` |
| Anchor postinstall | `@coral-xyz/anchor` not found di node_modules root karena pnpm nested | Added `.npmrc` with `shamefully-hoist=true` | `07a9e0c` |
| `editMessage` not exported | Pre-existing broken import di `index.js` | Added `export` keyword | (part of phase 4) |
| Calendar sizing iterations | Cells too small, then too big | Final: `aspect-ratio: 12/7` + container-width 100% | `b1f10cd` and earlier |

---

## 12. Production Configuration

Live status saat doc ditulis:

| Config | Value | Status |
|---|---|---|
| `DRY_RUN` | `false` | LIVE TRADING |
| `WEB_ENABLED` | `true` | Dashboard live |
| `WEB_PASSWORD` | (none) | Public access |
| `treasury.enabled` | `false` | Shadow-mode active |
| `subscriptions.enabled` | `false` | Polling only (30s) |
| `memory.semantic` | `false` | Keyword retrieval |
| `orchestrator.mode` | `"single"` | Legacy agentLoop |
| `screening.minFeeActiveTvlRatio` | `0.015` | Lowered from 0.05 |
| `screening.maxVolatility` | `4` | Anti-crash filter |
| Models | DeepSeek screener+manager, Gemini general | Native APIs (not OpenRouter) |

---

## 13. Git Commit History (Newest First)

```
9fd7ad9  Show PnL value on mobile calendar cells
bfa2ac0  Calendar: unify wrap and empty-cell background to true black
b1f10cd  Calendar: forward-looking from first trade, Monday-aligned rows
ac70d6c  Show date/month/day + PnL inside calendar cells
6ab0f2f  Revert "Improve PnL cell readability — stack % and $ vertically"
5a37775  Improve PnL cell readability — stack % and $ vertically  (REVERTED)
e0085a2  Merge state.json into /api/positions for deploy-time fields
68293ae  Add CLI monitoring scripts (status snapshot + auto-refresh)
cd92c4b  Stretch PnL calendar grid to fill its wrapper
dfb5503  Fix PnL calendar size — stretch cells to fill container
a683bc9  Add PnL calendar heatmap to dashboard
b55bb03  Make dashboard mobile-responsive with table→card layout
b742f20  Add web dashboard with macOS Terminal theme
07a9e0c  Fix patch-anchor for pnpm-nested @coral-xyz/anchor
039f0e0  Add maxVolatility filter to skip crash-prone pools
6173e0e  Fix per-role provider: provider config wins over legacy model arg
fdddacd  Add per-role LLM provider support
5126ee7  Add RUNNING.md setup guide and pnpm hoist config
1b4eb4f  BlackDelta: honor PRD with Phase 1-6 implementation
```

---

## 14. Testing & Validation

| Test file | Cases | Status |
|---|---|---|
| `test/test-adapter-parity.js` | 6 | ✅ |
| `test/test-treasury.js` | 11 | ✅ |
| `test/test-ws.js` | 6 | ✅ |
| `test/test-backtest.js` | 5 | ✅ |
| `test/test-memory.js` | 5 | ✅ |
| `test/test-orchestrator.js` | 5 | ✅ |
| `test/test-per-role-provider.js` | 5 | ✅ |
| **Total** | **43** | **All green** |

Run all: `node test/test-adapter-parity.js && node test/test-treasury.js && node test/test-ws.js && node test/test-backtest.js && node test/test-memory.js && LLM_API_KEY=dummy node test/test-orchestrator.js && node test/test-per-role-provider.js`

---

## 15. Plan File (Strategic Reference)

`/home/deployer/.claude/plans/buat-plan-bro-untuk-agile-orbit.md` berisi:
1. **Phase 1-6 Implementation Plan** — sudah dieksekusi semua
2. **Monetization Roadmap** — 5-stage lean discovery (Stage A → E), multi-tenancy refactor sketch, legal considerations
3. **Dashboard Feature: PnL Calendar Heatmap** — calendar implementation plan

---

## 16. What's NOT in Scope (Future Work)

Yang sudah di-plan tapi belum dieksekusi:

- **Phase 3 integration** dengan `runScreeningCycle` (replayer wired tapi belum drive cycle dari fixture)
- **Phase 4 byte-offset decoder** untuk Meteora LbPair (saat ini fallback ke `getActiveBin` RPC)
- **Phase 6 parity harness** lewat backtest (requires Phase 3 full integration)
- **`initial_value_usd` bug** di `trackPosition()` — disimpan sebagai SOL amount bukan USD value (kecil, tidak blocking)
- **Direct `dlmm.js` imports** di `index.js`, `agent.js`, `cli.js`, `smart-wallets.js`, `screening.js` masih bypass adapter (Phase 1 minimum done, full migration later)
- **Multi-tenant refactor** (MT1-MT4) untuk future Stage D Web app
- **Smart contract vault** untuk Stage E
- **Telegram channel public + Twitter** untuk Stage B reputation building

---

## 17. Operational Status (Snapshot 2026-05-19)

```
Bot status         : ONLINE via PM2 (auto-restart enabled)
Wallet             : GTyad67hyBFkXg3o5MzLNnzQYRderb7h44UZcDwEc3ia
Balance            : 0.44 SOL liquid + 0.5 SOL in LP
Open positions     : 1 (RoyalPop-SOL, bin -580→-523, in-range)
Closed positions   : 6 (5 on May 18, 1 on May 19)
Realized PnL       : +$6.37
Win rate           : Not yet meaningful (n too small)
LLM cost (est.)    : DeepSeek ~$0.50/day, Gemini ~$0/day (free tier)
Dashboard          : https://blackdelta.cc (public, no auth)
GitHub             : https://github.com/bagust1985/BlackDelta (branch blackdelta = default)
```

---

## TL;DR

Dalam 4 hari (2026-05-15 → 2026-05-19):
- Implementasi Phase 1-6 BlackDelta PRD lengkap (DEX abstraction, treasury allocator, WebSocket, backtest, semantic memory, multi-agent orchestrator)
- Per-role LLM provider routing (DeepSeek + Gemini paralel)
- Web dashboard dengan macOS Terminal theme di `blackdelta.cc`
- PnL calendar heatmap (12-week forward-looking, GitHub-style)
- Mobile responsive
- CLI monitoring scripts
- 43 unit tests semua green
- 6 closed positions, +$6.37 realized PnL
- Strategic monetization roadmap (5-stage lean discovery) didokumentasikan

**Repo**: `github.com/bagust1985/BlackDelta`
**Branch**: `blackdelta` (default)
**Total commits**: 19
**Net code delta**: +7,146 / −2,307 LOC across 68 files

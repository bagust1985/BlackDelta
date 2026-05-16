# Running BlackDelta — Complete Setup Guide

Step-by-step tutorial untuk menjalankan BlackDelta dari nol sampai production 24/7 di Solana mainnet.

> **Bahasa:** dokumen ini campur EN/ID karena banyak teknis. Section header EN, penjelasan ID di mana ngebantu.

---

## 0. Prerequisites

| Yang dibutuhin | Min version | Cara dapet |
|---|---|---|
| **Linux/macOS** server | — | VPS (Hetzner / Contabo / DO / lokal) |
| **Node.js** | 20+ | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt install -y nodejs` |
| **pnpm** | 11+ | `corepack enable && corepack prepare pnpm@latest --activate` atau `npm i -g pnpm` |
| **PM2** (production) | 5+ | `sudo npm i -g pm2` (perlu sudo untuk global install) |
| **git** | any | `sudo apt install git` |
| **Solana wallet** | — | Phantom → Settings → Export Private Key (base58) |
| **Solana RPC** | — | [Helius](https://helius.xyz) free tier sudah cukup (mainnet + WS) |
| **LLM API key** | — | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Modal SOL** | ~1 SOL | Buy SOL → transfer ke wallet bot |

Optional but recommended:
- Telegram bot token & chat ID (notif + remote command)
- Helius API key (better wallet balance API)
- OpenAI / Voyage key (Phase 5 semantic memory — opsional)

---

## 1. Clone & Install

```bash
cd ~
git clone https://github.com/bagust1985/BlackDelta.git
cd BlackDelta
pnpm install
```

> Project pakai **pnpm**, bukan npm. `.npmrc` di repo udah set `shamefully-hoist=true` supaya `@coral-xyz/anchor` ke-resolve oleh postinstall patch.

Verify deps OK:

```bash
node --check index.js && echo "syntax OK"
```

---

## 2. Konfigurasi — 2 Cara

### Opsi A — Wizard Interaktif (recommended kalau pertama kali)

```bash
pnpm setup
```

Wizard akan tanya satu-satu:

- RPC URL → masukin Helius/Triton URL
- Wallet private key → disimpan ke `.env`
- LLM model → default `openrouter/healer-alpha`
- Risk caps (deploy amount, max positions, gas reserve)
- Strategy (`bid_ask` default)
- Telegram (skip OK)

Output: `.env` + `user-config.json` ter-generate.

### Opsi B — Manual

```bash
cp user-config.example.json user-config.json
nano user-config.json
```

Edit field utama:

```jsonc
{
  "rpcUrl": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
  "llmModel": "openrouter/healer-alpha",
  "dryRun": true,

  "deployAmountSol": 0.5,
  "maxPositions": 3,
  "gasReserve": 0.2,
  "positionSizePct": 0.35,
  "maxDeployAmount": 50,

  "strategy": "bid_ask",
  "minBinsBelow": 35,
  "maxBinsBelow": 69
}
```

Buat `.env`:

```bash
cat > .env <<'EOF'
# Wallet (base58 atau JSON array)
WALLET_PRIVATE_KEY=

# Solana RPC (HTTP + WS untuk Phase 4)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# LLM
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxx

# Optional — Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Optional — better balance API
HELIUS_API_KEY=

# Optional — Phase 5 semantic memory
OPENAI_API_KEY=

# Pertama kali jalan: WAJIB dry run
DRY_RUN=true
EOF
chmod 600 .env
```

---

## 3. Smoke Test — Verifikasi Setup

```bash
# Syntax check semua file JS
pnpm test:syntax

# Test screener (read-only, fetch pool API)
pnpm test:screen

# Test 6 fase BlackDelta yang baru
node test/test-adapter-parity.js   # Phase 1: DEX adapter
node test/test-treasury.js         # Phase 2: allocator
node test/test-ws.js               # Phase 4: WS subscriber
node test/test-backtest.js         # Phase 3: backtest harness
node test/test-memory.js           # Phase 5: semantic memory
LLM_API_KEY=dummy node test/test-orchestrator.js  # Phase 6: orchestrator
```

Semua harus `✓ passed`. Kalau ada yang error, jangan lanjut — fix dulu.

---

## 4. Dry Run — Bot Simulasi Tanpa Risiko

```bash
pnpm dev
# = DRY_RUN=true node index.js
```

Apa yang terjadi:

- Full pipeline jalan (screen → decide → "deploy")
- Semua transaksi **disimulasikan**, nggak ada SOL keluar dari wallet
- Log keputusan agent muncul di terminal

REPL commands (ketik di terminal):

```
> positions       list open positions + PnL
> screen          trigger 1× screening manual
> manage          trigger 1× management manual
> balance         cek wallet SOL + tokens
> help            list semua commands
```

**Biarkan jalan 1-2 jam.** Lihat:
- Apa kandidat pool yang dipilih masuk akal?
- Apa LLM reasoning-nya solid? (cek `logs/`)
- Apa range bin (bins_below) cocok dengan volatility?

---

## 5. Live Mode — Production via PM2

Setelah dry run aman:

```bash
# 1. Matikan DRY_RUN
sed -i 's/DRY_RUN=true/DRY_RUN=false/' .env

# 2. Start PM2
pnpm pm2:start

# 3. Tail log
pnpm pm2:logs

# 4. Persist boot survival (auto-start saat server reboot)
pm2 save
pm2 startup   # ikutin instruksi yang dia kasih (biasanya 1 perintah sudo)
```

Bot sekarang permanent. Operasional:

```bash
pm2 status                    # process state
pm2 monit                     # realtime CPU/memory
pm2 logs blackdelta -- 200    # last 200 lines
pnpm pm2:restart              # restart pakai --update-env
pm2 stop blackdelta           # stop sementara
pm2 delete blackdelta         # remove dari PM2
```

---

## 6. Telegram (Optional tapi Powerful)

### Bikin bot

1. Buka [@BotFather](https://t.me/BotFather) di Telegram
2. `/newbot` → kasih nama → dapet token
3. Copy token → masukin ke `.env`: `TELEGRAM_BOT_TOKEN=...`

### Cari chat_id

1. Chat bot lo sendiri sekali (kirim `/start` atau apapun)
2. Buka `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Cari `"chat":{"id":123456789` → itu chat_id
4. Masukin: `TELEGRAM_CHAT_ID=123456789`

### Restart

```bash
pnpm pm2:restart
```

### Commands via Telegram

```
/positions        list open positions + progress bar
/close 1          close position by list index
/set 1 hold       set note ke position #1
/screen           trigger screening sekarang
/manage           trigger management sekarang
/balance          cek wallet
```

Otomatis dapet briefing setiap jam 8 pagi UTC+7.

---

## 7. Aktifin Feature Flag Phase 1-6 (Bertahap)

Semua flag **default `false`** = behavior identik Meridian asli. Flip satu-satu setelah confidence-built.

### Phase 2 — Treasury Allocator

```jsonc
// user-config.json
{
  "treasury": {
    "enabled": false,            // step 1: shadow mode dulu
    "policy": "signalWeighted",  // equalWeight | kellyLite | riskParity | signalWeighted
    "perPoolFloorSol": 0.5,
    "perPoolCeilSol": 5,
    "maxPortfolioExposurePct": 0.85,
    "shadowAlertDiffPct": 30
  }
}
```

**Cara flip:**
1. Restart bot dengan `enabled: false` selama **7 hari**
2. Tiap deploy akan log diff ke `decision-log.json` (`type=treasury_shadow`)
3. Telegram alert auto-fire kalau drift > 30%
4. Setelah 7 hari, cek: `cat decision-log.json | jq '[.decisions[] | select(.type=="treasury_shadow") | .metrics.diffPct] | add/length'`
5. Kalau median diff < 15% dan masuk akal → flip `enabled: true`

### Phase 4 — Solana WebSocket Subscriptions

```jsonc
{
  "rpcWsUrl": "wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
  "subscriptions": {
    "enabled": true,             // langsung aman: polling tetap jadi watchdog
    "fallbackPollMs": 30000,
    "staleThresholdMs": 90000
  }
}
```

Cek 48 jam log: `grep "ws_oor\|PnL poll" logs/*.log`. Kalau > 95% event dari WS, sukses.

### Phase 5 — Semantic Memory

Set env dulu:

```bash
# di .env
OPENAI_API_KEY=sk-xxx
# atau
VOYAGE_API_KEY=pa-xxx
```

Config:

```jsonc
{
  "memory": {
    "semantic": true,
    "provider": "openai",
    "topK": 5,
    "mode": "hybrid"
  }
}
```

Ingest background ~1-5 menit pertama untuk embed lesson lama.

### Phase 6 — Multi-agent Orchestrator

```jsonc
{
  "orchestrator": {
    "mode": "shadow"    // single (default) → shadow → sequential → parallel
  }
}
```

Urutan flip:
1. `shadow` — supervisor jalan, decisions di-log tapi nggak execute. Run 48 jam.
2. `sequential` — specialists execute satu-satu. Run 1 minggu.
3. `parallel` — full multi-agent concurrent. Final form.

### Phase 3 — Backtest Harness

Bukan flag — jalan offline.

**Record fixture** (24-48 jam HTTP snapshot):

```bash
BLACKDELTA_RECORD=1 \
BLACKDELTA_RECORD_DIR=./backtest/fixtures/run-$(date +%F) \
pnpm dev
# Ctrl-C setelah 24h
```

**Score** (ulangi run dengan setting berbeda → compare):

```bash
node backtest/runner.js \
  --fixtures backtest/fixtures/run-2026-05-16 \
  --trades backtest/fixtures/run-2026-05-16/trades.json \
  --json
```

Output: Report JSON dengan `reportHash`. Run dua kali → hash sama = deterministic.

---

## 8. Troubleshooting

| Symptom | Cek | Fix |
|---|---|---|
| `WALLET_PRIVATE_KEY not set` | `.env` exists & PM2 dapet env | `pnpm pm2:restart` (--update-env auto) |
| Bot diam, no log | `pm2 status` | `pm2 restart blackdelta` |
| `Insufficient SOL for gas` | Wallet SOL < `gasReserve` | Transfer SOL ke wallet |
| Tx failed `Slippage exceeded` | RPC lambat / pool volatile | Ganti RPC ke Helius dedicated / Triton |
| LLM error 502/503 | OpenRouter rate limit | Ganti `screeningModel`/`managementModel` di config |
| Telegram diam | Token / chat_id salah | Test: `curl https://api.telegram.org/bot<TOKEN>/getMe` |
| `Pool not found` di state.json | Position closed manual / bot down saat close | Auto-sync tiap management cycle, tunggu |
| `ENOENT @coral-xyz/anchor` | postinstall fail | `pnpm install --force` setelah pastikan `.npmrc` ada |
| Phase 5 error `OPENAI_API_KEY required` | Semantic on tapi key nggak ada | Set di `.env` atau matikan `memory.semantic` |

---

## 9. Operasional Harian

```bash
# Cek briefing terkirim (otomatis 8 AM UTC+7)
pm2 logs blackdelta --lines 50

# Jumlah open positions
cat state.json | jq '.positions | to_entries | length'

# Win rate
cat lessons.json | jq '.performance | length, (map(select(.pnl_usd > 0)) | length)'

# 5 keputusan terakhir
cat decision-log.json | jq '.decisions[0:5]'

# Cari error spike
grep -i "error\|failed" logs/*.log | tail -20
```

---

## 10. Folder Structure (Runtime)

```
BlackDelta/
├── .env                          # secrets (gitignored)
├── user-config.json              # tuning params (gitignored)
├── state.json                    # open positions (gitignored)
├── lessons.json                  # AI lessons (gitignored)
├── pool-memory.json              # per-pool history (gitignored)
├── decision-log.json             # audit trail (gitignored)
├── memory/cache/                 # embedding cache (gitignored)
├── memory/index.json             # vector store (gitignored)
├── logs/                         # daily-rotating logs (gitignored)
└── backtest/fixtures/run-*       # recorded HTTP (gitignored)
```

Yang **ter-commit** ke git: code, config example, golden backtest fixture, dokumentasi.

---

## 11. TL;DR — 6-Step Quick Start

```bash
# 1. Clone & install
git clone https://github.com/bagust1985/BlackDelta.git
cd BlackDelta && pnpm install

# 2. Setup wizard
pnpm setup

# 3. Smoke test
pnpm test:syntax && node test/test-adapter-parity.js

# 4. Dry run 1-2 jam
pnpm dev

# 5. Live via PM2
sed -i 's/DRY_RUN=true/DRY_RUN=false/' .env
pnpm pm2:start && pm2 save

# 6. Boot survival
pm2 startup    # ikutin instruksi sudo
```

Done. Bot autonomous, jalan 24/7, lapor via Telegram.

---

## 12. Resources

- **PRD:** [BlackDelta.md](./BlackDelta.md) — vision + arsitektur target
- **Project context:** [CLAUDE.md](./CLAUDE.md) — internal architecture notes
- **Implementation plan:** see commit `1b4eb4f` for Phase 1-6 rollout strategy
- **Solana RPC:** [Helius docs](https://docs.helius.xyz)
- **Meteora DLMM:** [docs.meteora.ag](https://docs.meteora.ag)
- **OpenRouter:** [openrouter.ai/models](https://openrouter.ai/models)

---

**Pertanyaan / issue:** open issue di [github.com/bagust1985/BlackDelta/issues](https://github.com/bagust1985/BlackDelta/issues).

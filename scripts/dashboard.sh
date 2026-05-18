#!/bin/bash
# BlackDelta status dashboard.
# Usage: scripts/dashboard.sh
# Refreshes every 30 seconds. Ctrl-C to quit.

REPO="/var/www/meridian"
PNPM_BIN="/home/deployer/.local/share/pnpm/bin"
export PATH="$PNPM_BIN:$PATH"

# ANSI colors
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[0;34m'; C='\033[0;36m'; W='\033[1;37m'; NC='\033[0m'

print_kv() {
  printf "  %-20s %s\n" "$1" "$2"
}

while true; do
  clear
  echo -e "${W}┌──────────────────────────────────────────────────────────┐${NC}"
  echo -e "${W}│  BlackDelta Dashboard — $(date '+%Y-%m-%d %H:%M:%S')           │${NC}"
  echo -e "${W}└──────────────────────────────────────────────────────────┘${NC}"
  echo ""

  # 1. PM2 status
  echo -e "${C}▎ Process${NC}"
  STATUS=$(pm2 jlist 2>/dev/null | node -e "
    const procs = JSON.parse(require('fs').readFileSync(0,'utf8') || '[]');
    const p = procs.find(x => x.name === 'blackdelta');
    if (!p) { console.log('OFFLINE'); process.exit(0); }
    const uptime = Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    console.log(p.pm2_env.status + '|' + h + 'h ' + m + 'm ' + s + 's|' + (p.monit?.memory || 0));
  " 2>/dev/null)
  if [ "$STATUS" = "OFFLINE" ]; then
    print_kv "Status" "$(echo -e "${R}OFFLINE${NC}")"
  else
    IFS='|' read -r state uptime mem <<< "$STATUS"
    color="$G"; [ "$state" != "online" ] && color="$R"
    print_kv "Status" "$(echo -e "${color}${state}${NC}")"
    print_kv "Uptime" "$uptime"
    print_kv "Memory" "$(echo "scale=1; $mem / 1048576" | bc 2>/dev/null || echo "?") MB"
  fi
  echo ""

  # 2. Mode + wallet
  echo -e "${C}▎ Config${NC}"
  DRY_RUN=$(grep "^DRY_RUN=" "$REPO/.env" 2>/dev/null | cut -d= -f2)
  if [ "$DRY_RUN" = "true" ]; then
    print_kv "Mode" "$(echo -e "${Y}DRY_RUN${NC} (no real tx)")"
  else
    print_kv "Mode" "$(echo -e "${R}LIVE${NC} (real tx active)")"
  fi

  # Wallet balance
  WALLET=$(cd "$REPO" && node -e "
    require('dotenv').config();
    const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
    const bs58 = require('bs58').default || require('bs58');
    (async () => {
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
        const conn = new Connection(process.env.RPC_URL, 'confirmed');
        const lamports = await conn.getBalance(kp.publicKey);
        console.log(kp.publicKey.toString() + '|' + (lamports / 1e9).toFixed(4));
      } catch (e) {
        console.log('ERROR|0');
      }
    })();
  " 2>/dev/null)
  IFS='|' read -r addr sol <<< "$WALLET"
  print_kv "Wallet" "${addr:0:8}...${addr: -8}"
  print_kv "Balance" "$sol SOL"
  echo ""

  # 3. Open positions
  echo -e "${C}▎ Positions${NC}"
  if [ -f "$REPO/state.json" ]; then
    POS_COUNT=$(node -e "
      try {
        const s = JSON.parse(require('fs').readFileSync('$REPO/state.json','utf8'));
        const open = Object.values(s.positions || {}).filter(p => !p.closed);
        console.log(open.length);
        for (const p of open.slice(0, 3)) {
          console.log('  • ' + (p.pool_name || p.pool?.slice(0,8) || '?') + ' | ' + (p.amount_sol || '?') + ' SOL | bin ' + (p.bin_range?.min ?? '?') + '-' + (p.bin_range?.max ?? '?'));
        }
      } catch { console.log('0'); }
    " 2>/dev/null)
    print_kv "Open" "$(echo "$POS_COUNT" | head -1)"
    echo "$POS_COUNT" | tail -n +2
  else
    print_kv "Open" "0 (state.json belum ada)"
  fi
  echo ""

  # 4. Recent decisions
  echo -e "${C}▎ Recent Decisions (last 5)${NC}"
  if [ -f "$REPO/decision-log.json" ]; then
    node -e "
      try {
        const d = JSON.parse(require('fs').readFileSync('$REPO/decision-log.json','utf8'));
        for (const x of (d.decisions || []).slice(0, 5)) {
          const time = x.ts ? x.ts.slice(11, 19) : '??';
          const type = x.type.toUpperCase().padEnd(15);
          const pool = (x.pool_name || x.pool?.slice(0,8) || '—').padEnd(14);
          const reason = (x.reason || x.summary || '').slice(0, 60).replace(/\n/g, ' ');
          console.log('  ' + time + ' ' + type + ' ' + pool + ' ' + reason);
        }
      } catch (e) { console.log('  (no decisions yet)'); }
    " 2>/dev/null
  else
    echo "  (decision-log.json belum ada)"
  fi
  echo ""

  # 5. Lessons recorded
  echo -e "${C}▎ Lessons & PnL${NC}"
  if [ -f "$REPO/lessons.json" ]; then
    node -e "
      try {
        const l = JSON.parse(require('fs').readFileSync('$REPO/lessons.json','utf8'));
        const perf = l.performance || [];
        const lessons = l.lessons || [];
        console.log('  Closed positions: ' + perf.length);
        console.log('  Lessons learned: ' + lessons.length);
        if (perf.length) {
          const totalPnl = perf.reduce((s, x) => s + (x.pnl_usd || 0), 0);
          const wins = perf.filter(x => (x.pnl_usd || 0) > 0).length;
          const winRate = (wins / perf.length * 100).toFixed(0);
          console.log('  Total PnL: \$' + totalPnl.toFixed(2));
          console.log('  Win rate: ' + winRate + '%');
        }
      } catch { console.log('  (no lessons yet)'); }
    " 2>/dev/null
  else
    echo "  (lessons.json belum ada — wajar di DRY_RUN)"
  fi
  echo ""

  # 6. Last log lines
  echo -e "${C}▎ Last 3 log lines${NC}"
  pm2 logs blackdelta --lines 3 --nostream --raw 2>/dev/null | tail -3 | sed 's/^/  /'
  echo ""

  echo -e "${W}─── Refresh in 30s • Ctrl-C to quit ───${NC}"
  sleep 30
done

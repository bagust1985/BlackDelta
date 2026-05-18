#!/bin/bash
# Single-frame status snapshot. Use 'watch -n 10 scripts/status.sh' for refresh.
# Or alias 'bd' in ~/.bashrc.

REPO="/var/www/meridian"
export PATH="/home/deployer/.local/share/pnpm/bin:$PATH"

# ANSI colors
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; W='\033[1;37m'; NC='\033[0m'

echo -e "${W}┌──────────────────────────────────────────────────────────┐${NC}"
echo -e "${W}│  BlackDelta Status — $(date '+%H:%M:%S')                          │${NC}"
echo -e "${W}└──────────────────────────────────────────────────────────┘${NC}"

# Process
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  const procs = JSON.parse(require('fs').readFileSync(0,'utf8') || '[]');
  const p = procs.find(x => x.name === 'blackdelta');
  if (!p) { console.log('OFFLINE'); process.exit(0); }
  const uptime = Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const memMb = Math.round((p.monit?.memory || 0) / 1048576);
  console.log(p.pm2_env.status + '|' + h + 'h ' + m + 'm|' + memMb);
" 2>/dev/null)

echo -e "\n${C}▎ Process${NC}"
if [ "$STATUS" = "OFFLINE" ]; then
  echo -e "  Status:  ${R}OFFLINE${NC}"
else
  IFS='|' read -r state uptime mem <<< "$STATUS"
  color="$G"; [ "$state" != "online" ] && color="$R"
  echo -e "  Status:  ${color}${state}${NC}   Uptime: ${uptime}   Mem: ${mem} MB"
fi

# Mode
DRY_RUN=$(grep "^DRY_RUN=" "$REPO/.env" 2>/dev/null | cut -d= -f2)
if [ "$DRY_RUN" = "true" ]; then
  echo -e "  Mode:    ${Y}DRY_RUN${NC} (no real tx)"
else
  echo -e "  Mode:    ${R}LIVE${NC} (real tx active)"
fi

# Wallet
WALLET=$(cd "$REPO" && node --input-type=module -e "
  await import('./envcrypt.js');
  const { Connection, Keypair } = await import('@solana/web3.js');
  const bs58Mod = await import('bs58');
  const bs58 = bs58Mod.default || bs58Mod;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    const conn = new Connection(process.env.RPC_URL, 'confirmed');
    const lamports = await conn.getBalance(kp.publicKey);
    console.log(kp.publicKey.toString() + '|' + (lamports / 1e9).toFixed(4));
  } catch (e) { console.log('ERROR|0'); }
" 2>/dev/null)
IFS='|' read -r addr sol <<< "$WALLET"
echo -e "\n${C}▎ Wallet${NC}"
echo -e "  Address: ${addr:0:8}...${addr: -8}"
echo -e "  Balance: ${W}${sol} SOL${NC}"

# Positions
echo -e "\n${C}▎ Positions${NC}"
node -e "
  try {
    const s = JSON.parse(require('fs').readFileSync('$REPO/state.json','utf8'));
    const open = Object.values(s.positions || {}).filter(p => !p.closed);
    console.log('  Open: ' + open.length);
    for (const p of open.slice(0, 5)) {
      console.log('    • ' + (p.pool_name || (p.pool || '?').slice(0,8)) + ' | ' + (p.amount_sol || '?') + ' SOL | bin ' + (p.bin_range?.min ?? '?') + '-' + (p.bin_range?.max ?? '?'));
    }
  } catch { console.log('  Open: 0 (no state.json)'); }
" 2>/dev/null

# Decisions
echo -e "\n${C}▎ Last 5 Decisions${NC}"
node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$REPO/decision-log.json','utf8'));
    for (const x of (d.decisions || []).slice(0, 5)) {
      const time = x.ts ? x.ts.slice(11, 19) : '??';
      const type = (x.type || '?').padEnd(15);
      const pool = (x.pool_name || (x.pool || '—').slice(0,10)).padEnd(14);
      const reason = (x.reason || x.summary || '').slice(0, 50).replace(/\n/g, ' ');
      console.log('  ' + time + ' ' + type + ' ' + pool + ' ' + reason);
    }
  } catch { console.log('  (no decisions yet)'); }
" 2>/dev/null

# Lessons & PnL
echo -e "\n${C}▎ Lessons & PnL${NC}"
node -e "
  try {
    const l = JSON.parse(require('fs').readFileSync('$REPO/lessons.json','utf8'));
    const perf = l.performance || [];
    const lessons = l.lessons || [];
    console.log('  Closed positions: ' + perf.length + ' | Lessons: ' + lessons.length);
    if (perf.length) {
      const totalPnl = perf.reduce((s, x) => s + (x.pnl_usd || 0), 0);
      const wins = perf.filter(x => (x.pnl_usd || 0) > 0).length;
      const winRate = (wins / perf.length * 100).toFixed(0);
      console.log('  Total PnL: \$' + totalPnl.toFixed(2) + ' | Win rate: ' + winRate + '%');
    }
  } catch { console.log('  (no lessons yet)'); }
" 2>/dev/null

echo ""

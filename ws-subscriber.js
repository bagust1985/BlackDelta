/**
 * BlackDelta Solana WebSocket subscriber.
 *
 * Maintains accountSubscribe subscriptions for open positions so the bot
 * can detect activeBin / tick changes in sub-second time instead of
 * waiting on the 30-second poller.
 *
 * Public API:
 *   wsSubscriber.start()
 *   wsSubscriber.stop()
 *   wsSubscriber.watch({ position, pool, dex, lower, upper })
 *   wsSubscriber.unwatch(position)
 *   wsSubscriber.lastEventAt() -> number (ms since last update for any sub)
 *   wsSubscriber.on("oor"|"tick"|"error", handler)
 *
 * Designed to be additive: when `config.subscriptions.enabled === false`
 * the module is a noop (`start()` returns immediately). The polling
 * loop in index.js stays as a watchdog and is only suppressed when WS
 * delivered an event within `staleThresholdMs`.
 */

import { EventEmitter } from "node:events";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getAdapter } from "./tools/dex/index.js";
import { getSharedConnection } from "./tools/dlmm.js";
import { sendMessage } from "./telegram.js";

class WsSubscriber extends EventEmitter {
  constructor() {
    super();
    this._subs = new Map(); // positionAddr -> { subId, account, dex, lower, upper, lastActive }
    this._started = false;
    this._lastEventAt = 0;
    this._reconnectAttempts = 0;
  }

  isEnabled() {
    return Boolean(config?.subscriptions?.enabled);
  }

  async start() {
    if (!this.isEnabled() || this._started) return;
    if (!process.env.RPC_URL) {
      log("ws_error", "subscriptions.enabled=true but RPC_URL is not set — disabling WS feed");
      return;
    }
    this._started = true;
    log("ws", "subscriber started");
  }

  async stop() {
    if (!this._started) return;
    const conn = getSharedConnection();
    for (const [, info] of this._subs) {
      try {
        await conn.removeAccountChangeListener(info.subId);
      } catch (err) {
        log("ws_warn", `unsubscribe failed: ${err.message}`);
      }
    }
    this._subs.clear();
    this._started = false;
    log("ws", "subscriber stopped");
  }

  /**
   * Begin watching a position. Subscribes to every account returned by
   * the adapter's `subscriptionAccounts(position)`. Activates a `tick`
   * event when the active bin changes, and `oor` when it leaves the
   * position's [lower, upper] range.
   */
  async watch(spec) {
    if (!this.isEnabled()) return null;
    const { position, pool, dex = "meteora", lower, upper } = spec;
    if (!position || !pool) return null;
    if (this._subs.has(position)) return this._subs.get(position).subId;

    const adapter = getAdapter(dex);
    const accounts = typeof adapter.subscriptionAccounts === "function"
      ? adapter.subscriptionAccounts({ pool, position })
      : [pool];
    if (!accounts.length) return null;

    const conn = getSharedConnection();
    const pk = new PublicKey(accounts[0]);
    const info = { subId: null, account: accounts[0], dex, pool, position, lower, upper, lastActive: null };

    try {
      info.subId = conn.onAccountChange(pk, async (accountInfo) => {
        this._lastEventAt = Date.now();
        try {
          let decoded = null;
          if (typeof adapter.decodeAccount === "function") {
            decoded = await adapter.decodeAccount(accountInfo.data);
          }
          let activeBin = decoded?.activeBin ?? null;
          // Fallback: ask the adapter via RPC if decoding failed.
          if (activeBin == null) {
            const live = await adapter.getActiveBin({ pool_address: pool }).catch(() => null);
            activeBin = live?.binId ?? live?.activeBin ?? null;
          }
          if (activeBin == null) return;
          const prev = info.lastActive;
          info.lastActive = activeBin;
          if (prev !== activeBin) {
            this.emit("tick", { dex, pool, position, activeBin, prevBin: prev });
          }
          if (Number.isFinite(lower) && Number.isFinite(upper)) {
            const oor = activeBin < lower || activeBin > upper;
            if (oor) {
              this.emit("oor", { dex, pool, position, activeBin, lower, upper });
            }
          }
        } catch (err) {
          this.emit("error", { stage: "decode", err, position });
        }
      }, "confirmed");
      this._subs.set(position, info);
      this._reconnectAttempts = 0; // healthy subscribe → reset backoff
      log("ws_watch", `${dex}/${position.slice(0, 8)} pool=${pool.slice(0, 8)} sub=${info.subId}`);
      return info.subId;
    } catch (err) {
      log("ws_error", `subscribe failed for ${position}: ${err.message}`);
      this.emit("error", { stage: "subscribe", err, position });
      this._scheduleReconnect(spec);
      return null;
    }
  }

  async unwatch(position) {
    if (!this._subs.has(position)) return;
    const info = this._subs.get(position);
    try {
      const conn = getSharedConnection();
      await conn.removeAccountChangeListener(info.subId);
    } catch (err) {
      log("ws_warn", `unsubscribe ${position} failed: ${err.message}`);
    }
    this._subs.delete(position);
    log("ws_unwatch", `${position.slice(0, 8)}`);
  }

  lastEventAt() {
    return this._lastEventAt;
  }

  /**
   * Check whether the WS feed has gone stale relative to the configured
   * staleThresholdMs. When stale, callers should fall back to the legacy
   * 30s poller and (optionally) telegram-alert.
   */
  isStale(nowMs = Date.now()) {
    if (!this.isEnabled() || this._lastEventAt === 0) return true;
    return nowMs - this._lastEventAt > (config.subscriptions.staleThresholdMs || 90000);
  }

  _scheduleReconnect(spec) {
    const base = config.subscriptions?.reconnectBaseMs || 2000;
    const max = config.subscriptions?.reconnectMaxMs || 60000;
    const delay = Math.min(max, base * Math.pow(2, this._reconnectAttempts));
    this._reconnectAttempts = Math.min(10, this._reconnectAttempts + 1);
    setTimeout(() => this.watch(spec).catch(() => {}), delay);
  }

  watchedPositions() {
    return Array.from(this._subs.keys());
  }
}

export const wsSubscriber = new WsSubscriber();

wsSubscriber.on("error", ({ stage, err }) => {
  log("ws_error_event", `${stage}: ${err?.message || err}`);
});

// One-shot Telegram alert when no WS event has been seen for too long.
let _lastStaleAlertAt = 0;
wsSubscriber.on("tick", () => { _lastStaleAlertAt = 0; });
setInterval(() => {
  if (!wsSubscriber.isEnabled()) return;
  if (!wsSubscriber._started) return;
  if (!wsSubscriber.watchedPositions().length) return;
  if (!wsSubscriber.isStale()) return;
  const now = Date.now();
  if (now - _lastStaleAlertAt < 30 * 60 * 1000) return; // throttle to 30 min
  _lastStaleAlertAt = now;
  sendMessage("⚠️ WS feed stale — falling back to poller. Check RPC ws endpoint.").catch(() => {});
}, 60_000).unref();

export default wsSubscriber;

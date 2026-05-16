/**
 * Meteora LbPair account decoder.
 *
 * Returns null pending a verified byte-offset decoder. The WS subscriber
 * falls back to adapter.getActiveBin() RPC call on every account-change
 * notification, which is still drastically faster than the legacy 30s
 * poller because it's event-driven.
 *
 * To enable an offset-based decoder, point `decodeLbPair` at a function
 * that reads `activeId` (signed i32) from the LbPair struct after the
 * anchor 8-byte discriminator + parameters + vParameters header. The
 * exact offset depends on the SDK version and should be cross-checked
 * against the on-chain layout before going live.
 */

export async function decodeLbPair(_buffer) {
  return null;
}

/**
 * Return the account addresses to subscribe for a given Meteora position.
 * For DLMM we subscribe to the LbPair account (carries activeId mutations).
 */
export function subscriptionAccounts(position) {
  if (!position || !position.pool) return [];
  return [position.pool];
}

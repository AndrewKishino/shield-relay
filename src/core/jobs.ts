import type { JobStatus } from '../store/index.js';

/**
 * The canonical WIRE status set ("shield-relay/1"). These are the ONLY statuses
 * sent to clients over the WebSocket. The internal `info_generated` (between
 * get-worker-info and submit-payment) is never emitted; `not_found` is emitted by
 * the WS hub for unknown/expired jobIds (it is not a stored job status).
 */
export const WIRE_STATUSES = [
  'queued',
  'verifying_payment',
  'payment_confirmed',
  'injecting_user_tx',
  'completed',
  'payment_failed',
  'user_tx_failed',
] as const;
export type WireStatus = (typeof WIRE_STATUSES)[number];

export function isWireStatus(s: string): s is WireStatus {
  return (WIRE_STATUSES as readonly string[]).includes(s);
}

/** Map an internal job status to its wire form, or null if it must not be sent. */
export function toWireStatus(status: JobStatus): WireStatus | null {
  return isWireStatus(status) ? status : null;
}

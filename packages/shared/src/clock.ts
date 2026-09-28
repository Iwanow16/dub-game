/**
 * NTP-like clock sync (§6.4): several ping/pong samples, keep the ones with the lowest RTT and
 * take the median offset. offset = serverNow - clientNow at the same instant.
 */
export interface ClockSample {
  clientSent: number;
  clientReceived: number;
  serverNow: number;
}

export function estimateOffset(samples: ClockSample[]): { offset: number; rtt: number } | null {
  if (samples.length === 0) return null;
  const withRtt = samples
    .map((s) => {
      const rtt = s.clientReceived - s.clientSent;
      return { rtt, offset: s.serverNow + rtt / 2 - s.clientReceived };
    })
    .sort((a, b) => a.rtt - b.rtt);
  // keep the better half (at least one) — high-RTT samples are the noisy ones
  const best = withRtt.slice(0, Math.max(1, Math.ceil(withRtt.length / 2)));
  const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const offset = offsets.length % 2 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
  return { offset, rtt: best[Math.floor(best.length / 2)]!.rtt };
}

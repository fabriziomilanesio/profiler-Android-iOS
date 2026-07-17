// Parser de red realtime (device-wide) desde /proc/net/dev.
//
// Por qué device-wide y no por-app: en Android 12+ sin root NO hay fuente realtime
// por-uid — /proc/net/xt_qtaguid está removido (API 36) y `dumpsys netstats` es por
// buckets horarios, no por segundo. eBPF per-uid necesita root. /proc/net/dev sí es
// legible sin root y da contadores acumulados por interfaz que se deltan por tick.
// Para un juego en foreground el tráfico del device ≈ el tráfico de la app.
//
// Formato /proc/net/dev (2 líneas de header + una por interfaz):
//   iface: rxBytes rxPackets errs drop fifo frame compressed multicast \
//          txBytes txPackets errs drop fifo colls carrier compressed
// rxBytes = col 0 tras el ':', txBytes = col 8.

// Interfaces que portan datos reales (excluye lo, dummy, ifb, túneles, p2p, epdg…).
// rmnet cubre las variantes Qualcomm (rmnet_data0/rmnet_ipa0) además del rmnet0 clásico;
// ccmni es MediaTek.
const DATA_IFACE = /^(wlan|eth|rmnet(_data|_ipa)?|ccmni|usb|rndis|ap)\d*$/

export interface NetSnapshot {
  rxBytes: number
  txBytes: number
  /** epoch ms de la lectura (para el delta por tiempo real transcurrido) */
  ts: number
}

/** Suma rx/tx de todas las interfaces de datos. null si no parsea ninguna línea. */
export function parseNetDev(raw: string, ts: number): NetSnapshot | null {
  let rxBytes = 0
  let txBytes = 0
  let matched = false
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const iface = line.slice(0, colon).trim()
    if (!DATA_IFACE.test(iface)) continue
    const cols = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    const rx = cols[0]
    const tx = cols[8]
    if (rx === undefined || tx === undefined || !Number.isFinite(rx) || !Number.isFinite(tx))
      continue
    rxBytes += rx
    txBytes += tx
    matched = true
  }
  return matched ? { rxBytes, txBytes, ts } : null
}

/** Throughput en KB/s entre dos snapshots. null si no computa; acota reinicios de contador a 0. */
export function netThroughputKb(
  prev: NetSnapshot,
  next: NetSnapshot,
): { rxKb: number; txKb: number } | null {
  const dtSec = (next.ts - prev.ts) / 1000
  if (dtSec <= 0) return null
  const dRx = next.rxBytes - prev.rxBytes
  const dTx = next.txBytes - prev.txBytes
  // contador que baja = reinicio de interfaz (ej. wifi reconectó) → 0, no negativo.
  return {
    rxKb: Math.max(0, dRx) / 1024 / dtSec,
    txKb: Math.max(0, dTx) / 1024 / dtSec,
  }
}

// Tipos del dominio del profiler (ticket 021). El shape de `Sample` es el contrato
// entre el sampler (backend) y el dashboard (UI): cada tick emite un `Sample`.
//
// Convención "no disponible" = null explícito. Un collector que no pudo leer su
// métrica en este device marca su campo (o sub-campo) null; el UI lo dibuja como
// N/A. Nunca se usa 0 para "no disponible" (0 es un valor legítimo).

/** Composición de memoria (PSS por categoría, en MB). null = categoría no reportada. */
export interface MemBreakdown {
  /** Java Heap (App Summary) */
  java: number | null
  /** Native Heap */
  native: number | null
  /** Graphics (EGL + GL mtrack; 0 real ⇒ memtrack HAL ausente ⇒ null) */
  graphics: number | null
  /** Code (.so/.dex/.oat/.apk/.art) */
  code: number | null
  /** Stack */
  stack: number | null
  /** Private Other + System (todo lo demás del App Summary) */
  other: number | null
}

/** Muestra de memoria: total PSS + breakdown. */
export interface MemSample {
  /** TOTAL PSS del App Summary, en MB */
  pss: number | null
  /**
   * RSS en MB desde /proc/<pid>/status (VmRSS, main + hijos). A diferencia del
   * resto (carril lento, dumpsys meminfo cada ~15 s), se refresca en cada tick:
   * el cat combinado del sampler ya lee /proc, así que es gratis. RSS ≥ PSS
   * (no prorratea memoria compartida) — es la señal "viva", no comparable 1:1.
   */
  rss: number | null
  java: number | null
  native: number | null
  graphics: number | null
  code: number | null
  stack: number | null
  other: number | null
}

/**
 * Frame-times y jank del tick (ticket 024), derivados del histograma
 * present2present del MISMO dump de SurfaceFlinger timestats que ya trae el FPS —
 * cero comandos adb extra. El umbral de jank es relativo a la cadencia propia de
 * la app medida en vsyncs REALES del panel (60/90/120 Hz), no 16.6 ms fijo.
 */
export interface FrameSample {
  /** frame-time mediano del tick, en ms (intervalo present→present) */
  p50Ms: number | null
  /** frame-time p90 del tick, en ms */
  p90Ms: number | null
  /** frame-time p99 del tick, en ms */
  p99Ms: number | null
  /** % de frames del tick que perdieron ≥1 vsync vs la cadencia de la app (0–100) */
  jankPct: number | null
  /** conteo de frames que perdieron ≥1 vsync (los mismos del jankPct) */
  jankFrames: number | null
  /** frames medidos en la ventana del tick (pondera el jank% de la sesión) */
  totalFrames: number | null
}

/** Estado de batería (`dumpsys battery`). */
export interface BatterySample {
  /** nivel 0–100 (%) */
  levelPct: number | null
  /** temperatura en °C (deci-°C ÷ 10) */
  tempC: number | null
  /** corriente instantánea en mA (positivo ⇒ carga, negativo ⇒ drena; el signo/OEM varía) */
  mA: number | null
  /** true si está enchufado (AC/USB/wireless) — cargando, no hay drenaje real */
  charging: boolean | null
}

/**
 * Una muestra completa del profiler en un tick (≈1 Hz). Todo campo puede ser null
 * ("no disponible en este device / falló el collector este tick").
 */
export interface Sample {
  /** segundo de sesión (0-based) */
  t: number
  /** timestamp epoch (ms) del tick */
  ts: number
  /** CPU de la app (suma de sus procesos), share-of-device 0–100 (%) */
  cpu: number | null
  /** CPU total del device (todos los procesos), 0–100 (%) */
  deviceCpu: number | null
  /** RAM usada total del device en MB (MemTotal − MemAvailable) */
  deviceRamUsedMb: number | null
  /** GPU utilization 0–100 (%) */
  gpu: number | null
  /** FPS promedio (averageFPS de SurfaceFlinger timestats) */
  fps: number | null
  /** frame-times/jank del tick (mismo dump que fps). Sesiones viejas: undefined. */
  frame: FrameSample
  /** temperatura principal (CPU/AP) en °C */
  tempC: number | null
  /** memoria PSS + breakdown */
  mem: MemSample
  /** batería */
  battery: BatterySample
  /** red rx este segundo (KB/s) — null hasta que exista fuente realtime confiable */
  netRxKb: number | null
  /** red tx este segundo (KB/s) */
  netTxKb: number | null
}

/** Ficha del device, capturada una vez al conectar. */
export interface DeviceInfo {
  serial: string
  /** ro.product.model (ej. SM-A155M) */
  model: string | null
  /** ro.product.manufacturer (ej. samsung) */
  manufacturer: string | null
  /** ro.build.version.release (ej. 16) */
  androidRelease: string | null
  /** ro.build.version.sdk (ej. 36) */
  apiLevel: number | null
  /** ro.board.platform / ro.soc.model (ej. mt6789) */
  soc: string | null
  /** nombre limpio de la GPU (ej. Mali-G57 MC2) */
  gpu: string | null
  /** RAM total en MB (MemTotal de /proc/meminfo) */
  ramTotalMb: number | null
  /** cores de CPU online (nproc) — para el label "≈ X% de un core" */
  cores: number | null
  /**
   * Refresh rate real del panel en Hz (60/90/120…), leído UNA vez al conectar
   * desde la primera línea de `dumpsys SurfaceFlinger --latency` (período de
   * refresh en ns — la línea más estable del comando, presente aun cuando el
   * layer no matchea). null = no se pudo leer (el jank cae a 60 Hz).
   */
  refreshHz: number | null
}

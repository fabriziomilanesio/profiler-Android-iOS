// Resolución del proceso de una app iOS. Los casos vienen de un iPhone real (15,3 con
// iOS 26.5.2): el bundle id NO alcanza para saber cómo se llama el proceso.
import { describe, expect, test } from 'bun:test'
import { resolveIosProcess, type IosProcess } from './deviceInfo'

// recorte real de `pymobiledevice3 processes ps`
const PROCESSES: IosProcess[] = [
  { pid: 33248, name: 'SpringBoard' },
  { pid: 67675, name: 'GitHub' },
  { pid: 67963, name: 'Gmail' },
  { pid: 67967, name: 'Camera' },
  { pid: 67877, name: 'AppPredictionIntentsHelperServi' }, // sysmontap trunca los largos
  { pid: 68010, name: 'AudioConverterService' },
]

describe('resolveIosProcess', () => {
  test('el CFBundleExecutable resuelve lo que el bundle id no puede', () => {
    // EL BUG: com.github.stormbreaker.prod → último segmento "prod", que no existe. La app
    // quedaba elegida en el dashboard pero sin CPU ni memoria, porque el canal de sysmon
    // nunca enganchaba un proceso.
    expect(resolveIosProcess(PROCESSES, 'com.github.stormbreaker.prod')).toBeNull()
    expect(resolveIosProcess(PROCESSES, 'com.github.stormbreaker.prod', 'GitHub')?.pid).toBe(67675)
  })

  test('sin ejecutable, la heurística del último segmento sigue sirviendo', () => {
    // Es el caso feliz que ya funcionaba: el último segmento coincide con el binario.
    expect(resolveIosProcess(PROCESSES, 'com.google.Gmail')?.pid).toBe(67963)
    expect(resolveIosProcess(PROCESSES, 'com.apple.camera')?.pid).toBe(67967)
  })

  test('el ejecutable manda por encima de la heurística', () => {
    // "com.x.camera" apuntaría a Camera por el último segmento; el ejecutable dice Gmail.
    expect(resolveIosProcess(PROCESSES, 'com.x.camera', 'Gmail')?.pid).toBe(67963)
  })

  test('nombres truncados por sysmontap se enganchan por prefijo', () => {
    const found = resolveIosProcess(PROCESSES, 'com.apple.x', 'AppPredictionIntentsHelperService')
    expect(found?.pid).toBe(67877)
  })

  test('sin match no inventa un proceso', () => {
    expect(resolveIosProcess(PROCESSES, 'com.nada.deesto', 'NoExiste')).toBeNull()
    expect(resolveIosProcess([], 'com.google.Gmail', 'Gmail')).toBeNull()
  })

  test('un ejecutable corto no se engancha con cualquier daemon por prefijo', () => {
    // El piso de 8 caracteres evita que un ejecutable "A" matchee cualquier cosa.
    expect(resolveIosProcess(PROCESSES, 'com.x.y', 'Gm')).toBeNull()
  })
})

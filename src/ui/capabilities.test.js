// Tests de la lógica de capacidades de la UI (ticket 040). Sin browser: se arma un DOM
// mínimo falso con lo único que usa `apply` (querySelectorAll + getAttribute + hidden).
import { describe, expect, test } from 'bun:test'
import { apply, memoryLabel, modelName, osLabel } from './capabilities.js'

/** DOM falso: una lista de nodos con su data-cap. */
function fakeRoot(caps) {
  const nodes = caps.map((c) => ({ cap: c, hidden: false, getAttribute: () => c }))
  return {
    nodes,
    querySelectorAll: () => nodes,
  }
}

const IOS = {
  frameTimes: false,
  memoryBreakdown: false,
  temperature: false,
  network: false,
  logs: false,
  httpInspector: false,
  fps: true,
  gpu: true,
  cpu: true,
  memory: true,
  battery: true,
}

describe('apply', () => {
  test('oculta lo que la plataforma no soporta', () => {
    const root = fakeRoot(['frameTimes', 'temperature', 'network'])
    const hidden = apply(root, IOS)
    expect(hidden).toBe(3)
    expect(root.nodes.every((n) => n.hidden)).toBe(true)
  })

  test('deja visible lo que sí soporta', () => {
    const root = fakeRoot(['fps', 'gpu', 'memory'])
    expect(apply(root, IOS)).toBe(0)
    expect(root.nodes.every((n) => !n.hidden)).toBe(true)
  })

  test('sin capacidades no esconde nada — el default es el comportamiento de siempre', () => {
    // Server viejo o mensaje todavía no recibido: nunca hay que romper el dashboard.
    const root = fakeRoot(['frameTimes', 'temperature'])
    expect(apply(root, undefined)).toBe(0)
    expect(root.nodes.every((n) => !n.hidden)).toBe(true)
  })

  test('una capability desconocida se considera soportada', () => {
    // Marcado más nuevo que el server: mejor mostrar de más que esconder de más.
    const root = fakeRoot(['algoNuevo'])
    expect(apply(root, IOS)).toBe(0)
  })

  test('volver a Android re-muestra lo que se había ocultado', () => {
    // Cambiar de iPhone a Android en caliente no puede dejar tiles escondidos para siempre.
    const root = fakeRoot(['frameTimes', 'temperature'])
    apply(root, IOS)
    expect(root.nodes.every((n) => n.hidden)).toBe(true)
    apply(root, { frameTimes: true, temperature: true })
    expect(root.nodes.every((n) => !n.hidden)).toBe(true)
  })

  test('root inválido no explota', () => {
    expect(apply(null, IOS)).toBe(0)
    expect(apply({}, IOS)).toBe(0)
  })
})

describe('etiquetas por plataforma', () => {
  test('el total de memoria NO se llama PSS en iOS', () => {
    // PSS prorratea memoria compartida; physFootprint no. Etiquetarlo mal reintroduce
    // en la UI el bug que el schema evita separando los campos.
    expect(memoryLabel('ios')).toBe('Footprint')
    expect(memoryLabel('android')).toBe('PSS')
  })

  test('la versión del SO se etiqueta según la plataforma', () => {
    expect(osLabel('ios')).toBe('iOS')
    expect(osLabel('android')).toBe('Android')
  })

  test('sin plataforma se asume Android (sesiones viejas)', () => {
    expect(memoryLabel(undefined)).toBe('PSS')
    expect(osLabel(undefined)).toBe('Android')
  })
})

describe('modelName', () => {
  test('traduce el ProductType de Apple al nombre comercial', () => {
    // Apple no expone el nombre comercial por ningún servicio: sólo "iPhone15,3".
    expect(modelName('iPhone15,3')).toBe('iPhone 14 Pro Max')
    expect(modelName('iPad13,4')).toBe('iPad Pro 11 (3ra gen)')
  })

  test('un modelo desconocido devuelve el identificador CRUDO', () => {
    // La tabla envejece con cada modelo nuevo; un id googleable es mejor que un nombre
    // inventado o un "Desconocido".
    expect(modelName('iPhone99,9')).toBe('iPhone99,9')
  })

  test('no toca los modelos de Android, que ya son legibles', () => {
    expect(modelName('SM-A155M')).toBe('SM-A155M')
  })

  test('sin modelo no explota', () => {
    expect(modelName(null)).toBeNull()
    expect(modelName(undefined)).toBeUndefined()
  })
})

describe('el inspector y la red se esconden en iOS', () => {
  // Pedido explícito del usuario: si el device es un iPhone o iPad, no se ofrece. En
  // Android la tool setea el proxy del device sola; en iOS hay que configurarlo a mano en
  // Ajustes y confiar la CA — un toggle que no puede cumplir es peor que no estar.
  test('httpInspector y network quedan ocultos', () => {
    const root = fakeRoot(['httpInspector', 'network'])
    expect(apply(root, IOS)).toBe(2)
    expect(root.nodes.every((n) => n.hidden)).toBe(true)
  })

  test('en Android siguen visibles', () => {
    const root = fakeRoot(['httpInspector', 'network'])
    expect(apply(root, { httpInspector: true, network: true })).toBe(0)
  })
})

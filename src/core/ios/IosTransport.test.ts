// Tests del transporte iOS: descubrimiento del intérprete y el env de los streams.
import { describe, expect, test } from 'bun:test'
import { discoverPython, managedVenvPython, systemPython } from './IosTransport'

describe('discoverPython', () => {
  test('respeta el intérprete explícito por encima de todo', () => {
    expect(discoverPython('/usr/bin/python3.12', () => true)).toBe('/usr/bin/python3.12')
  })

  test('prefiere el venv gestionado cuando existe', () => {
    // Es el mismo patrón que installPlatformTools con adb: la tool se ocupa de su
    // toolchain en vez de ensuciar el Python del sistema (y esquiva PEP 668).
    expect(discoverPython(undefined, () => true)).toBe(managedVenvPython())
  })

  // Sin OS explícito estos dos caen al del host: comparar contra el literal 'python3'
  // los hacía fallar en Windows, donde el intérprete del sistema es 'python'. Lo que
  // se afirma acá es "cae al Python del sistema", no cuál es su nombre — eso ya lo
  // cubre el bloque de compatibilidad de abajo.
  test('cae al Python del sistema si no hay venv', () => {
    expect(discoverPython(undefined, () => false)).toBe(systemPython())
  })

  test('un explícito vacío no cuenta como explícito', () => {
    expect(discoverPython('', () => false)).toBe(systemPython())
  })
})

describe('managedVenvPython', () => {
  test('vive junto a las sesiones, en ~/.sample-profiler', () => {
    expect(managedVenvPython('/home/x')).toContain('.sample-profiler')
    expect(managedVenvPython('/home/x')).toContain('pmd3-venv')
  })
})

describe('compatibilidad con Windows', () => {
  test('en Windows el intérprete del sistema es `python`, NO `python3`', () => {
    // `python3` no existe en Windows: dejaba el camino iOS muerto ahí, con spawn fallando
    // por ENOENT y `isAvailable()` devolviendo false — que se lee como "pymobiledevice3 no
    // está instalado" cuando el problema es otro.
    expect(systemPython('win32')).toBe('python')
    expect(systemPython('darwin')).toBe('python3')
    expect(systemPython('linux')).toBe('python3')
  })

  test('el venv de Windows vive en Scripts\\python.exe', () => {
    const win = managedVenvPython('C:\\Users\\x', 'win32')
    expect(win).toContain('Scripts')
    expect(win).toContain('python.exe')
    expect(managedVenvPython('/home/x', 'darwin')).toContain('bin')
  })

  test('sin venv, el fallback respeta el OS', () => {
    expect(discoverPython(undefined, () => false, 'win32')).toBe('python')
    expect(discoverPython(undefined, () => false, 'darwin')).toBe('python3')
  })
})

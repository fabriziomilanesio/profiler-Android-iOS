// Tests capa 1 del parser de logcat: contra fixtures con líneas reales
// representativas de una app Unity en formato `-v threadtime -v year`
// (fixtures/logcat/), incluyendo crash multi-línea, crash nativo y ANR.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLogcatLine } from './parseLogcat'

const FIXTURES = join(import.meta.dir, '../../../fixtures/logcat')
const unityLines = readFileSync(join(FIXTURES, 'unity-threadtime.txt'), 'utf8').split('\n')
const crashLines = readFileSync(join(FIXTURES, 'crash-events.txt'), 'utf8').split('\n')

describe('parseLogcatLine (threadtime,year)', () => {
  test('parsea una línea Unity completa: ts, pid, tid, level, tag, message', () => {
    const p = parseLogcatLine(
      '2026-07-31 10:15:02.087 18743 18790 I Unity   : MemoryManager: Using accents',
    )
    expect(p).toEqual({
      ts: new Date(2026, 6, 31, 10, 15, 2, 87).getTime(),
      pid: 18743,
      tid: 18790,
      level: 'I',
      tag: 'Unity',
      message: 'MemoryManager: Using accents',
    })
  })

  test('fixture Unity: parsea todas las entradas y saltea separadores/basura', () => {
    const parsed = unityLines.filter(Boolean).map((l) => parseLogcatLine(l))
    const entries = parsed.filter((p) => p !== null)
    // 20 líneas: 2 separadores + 1 línea basura ⇒ 17 entradas
    expect(entries).toHaveLength(17)
    // el tag Unity domina (Debug.Log/LogError de Unity salen por ahí)
    expect(entries.filter((e) => e.tag === 'Unity').length).toBeGreaterThanOrEqual(10)
    // todos los niveles del fixture presentes
    const levels = new Set(entries.map((e) => e.level))
    for (const lvl of ['V', 'D', 'I', 'W', 'E']) expect(levels.has(lvl as 'V')).toBe(true)
  })

  test('separadores, vacías y basura ⇒ null', () => {
    expect(parseLogcatLine('--------- beginning of main')).toBeNull()
    expect(parseLogcatLine('')).toBeNull()
    expect(parseLogcatLine('esta linea no es logcat y el parser la ignora')).toBeNull()
  })

  test('CRLF de adb shell v1: el \\r final se recorta (no queda en el message)', () => {
    const p = parseLogcatLine('2026-07-31 10:15:02.087 18743 18790 I Unity   : hola\r')
    expect(p?.message).toBe('hola')
    // separador con \r también se reconoce como separador
    expect(parseLogcatLine('--------- beginning of main\r')).toBeNull()
  })

  test('mensaje vacío es válido (Debug.Log(""))', () => {
    const p = parseLogcatLine('2026-07-31 10:15:02.322 18743 18790 I Unity   :')
    expect(p?.message).toBe('')
  })

  test('tag con corchetes/guiones se parsea entero', () => {
    const p = parseLogcatLine(
      '2026-07-31 10:15:03.560 18743 18743 W ViewRootImpl[UnityPlayerActivity]: Dropping event',
    )
    expect(p?.tag).toBe('ViewRootImpl[UnityPlayerActivity]')
    expect(p?.level).toBe('W')
  })

  test('línea sin año (threadtime pelado) usa el fallbackYear', () => {
    const p = parseLogcatLine('07-31 10:15:08.100 18743 18790 I Unity   : Legacy line', {
      fallbackYear: 2031,
    })
    expect(p?.ts).toBe(new Date(2031, 6, 31, 10, 15, 8, 100).getTime())
  })

  test('stacktrace Unity multi-línea: orden preservado, mismo tag/pid/tid', () => {
    const stack = unityLines
      .map((l) => parseLogcatLine(l))
      .filter((p): p is NonNullable<typeof p> => p !== null && p.level === 'E' && p.tag === 'Unity')
    expect(stack.length).toBe(5)
    expect(stack[0]!.message).toStartWith('NullReferenceException')
    // continuation lines en orden, con su indentación viva (se recorta 1 solo espacio)
    expect(stack[1]!.message).toContain('at MusicPlayer.PlayTrack')
    expect(stack[2]!.message).toContain('at UIController.OnPlayPressed')
    expect(new Set(stack.map((s) => `${s.pid}/${s.tid}`)).size).toBe(1)
  })

  test('crash Java multi-línea: la indentación con tab de los frames sobrevive', () => {
    const frames = crashLines
      .map((l) => parseLogcatLine(l))
      .filter((p) => p !== null && p.tag === 'AndroidRuntime' && p.pid === 18743)
    expect(frames.length).toBe(7)
    expect(frames[0]!.message).toBe('FATAL EXCEPTION: UnityMain')
    expect(frames[3]!.message).toStartWith('\tat com.unity3d.player.UnityPlayer')
  })

  test('crash nativo (buffer crash): nivel F de libc/DEBUG', () => {
    const native = crashLines
      .map((l) => parseLogcatLine(l))
      .filter((p) => p !== null && p.level === 'F')
    expect(native.length).toBe(5)
    expect(native[0]!.tag).toBe('libc')
    expect(native[0]!.message).toStartWith('Fatal signal 11 (SIGSEGV)')
  })

  test('evento am_anr (buffer events) se parsea como entrada normal', () => {
    const anr = crashLines.map((l) => parseLogcatLine(l)).find((p) => p?.tag === 'am_anr')
    expect(anr?.pid).toBe(612)
    expect(anr?.message).toContain('com.sample.oda.qa')
  })
})

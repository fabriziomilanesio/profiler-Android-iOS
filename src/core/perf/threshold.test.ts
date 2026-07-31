import { describe, expect, test } from 'bun:test'
import { FPS_YELLOW_RATIO, fpsStatus } from './threshold'

describe('fpsStatus (semáforo del ticket 025)', () => {
  test('target 30 (default): verde ≥ 30, amarillo ≥ 24 (80%), rojo abajo', () => {
    expect(fpsStatus(60, 30)).toBe('green')
    expect(fpsStatus(30, 30)).toBe('green') // borde: igual al target es verde
    expect(fpsStatus(29.9, 30)).toBe('yellow')
    expect(fpsStatus(24, 30)).toBe('yellow') // borde: exactamente 80% es amarillo
    expect(fpsStatus(23.9, 30)).toBe('red')
    expect(fpsStatus(0, 30)).toBe('red') // 0 FPS es un dato real (app congelada)
  })

  test('el umbral escala con el target (60 ⇒ amarillo desde 48)', () => {
    expect(FPS_YELLOW_RATIO).toBe(0.8)
    expect(fpsStatus(60, 60)).toBe('green')
    expect(fpsStatus(48, 60)).toBe('yellow')
    expect(fpsStatus(47.9, 60)).toBe('red')
  })

  test('sin FPS ⇒ null (sin color), nunca rojo', () => {
    expect(fpsStatus(null, 30)).toBeNull()
    expect(fpsStatus(Number.NaN, 30)).toBeNull()
    expect(fpsStatus(Number.POSITIVE_INFINITY, 30)).toBeNull()
    expect(fpsStatus(-1, 30)).toBeNull() // un FPS negativo es basura del parser, no rojo
  })

  test('target inválido ⇒ null (config rota no pinta de rojo el dashboard)', () => {
    expect(fpsStatus(30, 0)).toBeNull()
    expect(fpsStatus(30, -30)).toBeNull()
    expect(fpsStatus(30, Number.NaN)).toBeNull()
  })
})

// E2E del estado de conexión (ticket 046, escenario de desconexión del ticket 014).
//
// Es la única cobertura del camino completo server → WebSocket → dashboard: los tests
// unitarios llegan hasta el mensaje `connection`, y de ahí a lo que ve el QA hay JS de UI
// que nadie estaba ejercitando.
import { expect, test } from '@playwright/test'

const CONTROL = 'http://localhost:8789'
const badge = '#recLabel'

/** Vuelve a dejar el harness enchufado y esperando el próximo test. */
async function replug(page: import('@playwright/test').Page): Promise<void> {
  await page.request.get(`${CONTROL}/plug`)
  await expect(page.locator(badge)).toHaveText('LIVE')
}

test.describe('estado de conexión en el dashboard', () => {
  test('con el device enganchado muestra LIVE y datos vivos', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(badge)).toHaveText('LIVE')
    // el badge no miente por omisión: hay métricas llegando detrás
    await expect(page.locator('#fpsNum')).toContainText('58')
  })

  test('muerto el canal vital pasa a RECONNECTING y vuelve solo', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(badge)).toHaveText('LIVE')

    // el túnel se cae pero el device sigue en el bus: ventana de gracia
    await page.request.get(`${CONTROL}/kill-vital`)
    await expect(page.locator(badge)).toHaveText('RECONNECTING')

    // vencida la gracia el server suelta el device y el watcher lo re-engancha solo
    await expect(page.locator(badge)).toHaveText('LIVE', { timeout: 20_000 })
  })

  test('desenchufado muestra NO DEVICE, y al volver reengancha', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(badge)).toHaveText('LIVE')

    await page.request.get(`${CONTROL}/unplug`)
    await expect(page.locator(badge)).toHaveText('NO DEVICE', { timeout: 20_000 })

    await replug(page)
  })

  test('un dashboard abierto con el device caído NO pinta un device fantasma', async ({ page }) => {
    // Regresión del 046: onOpen manda la ficha del ÚLTIMO device conocido. Sin el mensaje
    // `connection` en el saludo, una pestaña nueva mostraba LIVE con el cable afuera.
    await page.goto('/')
    await expect(page.locator(badge)).toHaveText('LIVE')
    await page.request.get(`${CONTROL}/unplug`)
    await expect(page.locator(badge)).toHaveText('NO DEVICE', { timeout: 20_000 })

    await page.reload()
    await expect(page.locator(badge)).toHaveText('NO DEVICE')

    await replug(page)
  })
})

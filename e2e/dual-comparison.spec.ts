import { expect, test } from '@playwright/test'

test.describe('dual comparison QoL', () => {
  test('keeps connected devices visible during a slow refresh', async ({ page }) => {
    await page.goto('/')
    await page.locator('#dualToggle').click()
    const secondary = page.locator('iframe[data-pane="secondary"]').contentFrame()
    await secondary.locator('#devBtn').click()
    await expect(secondary.locator('#devList')).toContainText('UDID-E2E-B')

    await fetch('http://localhost:8789/slow-devices')
    try {
      await secondary.locator('#devRefresh').click()
      await expect(secondary.locator('#devRefresh')).toContainText('Searching')
      await expect(secondary.locator('#devList')).toContainText('UDID-E2E-B')
      await secondary.locator('#devList button').filter({ hasText: 'UDID-E2E-B' }).click()
      await expect(secondary.locator('#devName')).toContainText('iPhone 15 Pro Max', {
        timeout: 800,
      })
      await expect(secondary.locator('#devRefresh')).toHaveText('⟳ Refresh', { timeout: 3000 })
    } finally {
      await fetch('http://localhost:8789/normal-devices')
    }
  })

  test('mirrors device A in B without starting a secondary lane', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#recLabel')).toHaveText('LIVE')
    await page.locator('#dualToggle').click()

    const primary = page.locator('iframe[data-pane="primary"]').contentFrame()
    const secondaryFrame = page.locator('iframe[data-pane="secondary"]')
    const secondary = secondaryFrame.contentFrame()
    await expect(primary.locator('#devName')).not.toHaveText('Waiting for device…')
    await secondary.locator('#devBtn').click()
    await secondary.locator('#devList button').filter({ hasText: 'UDID-E2E' }).first().click()

    await expect(secondary.locator('body')).toHaveClass(/dual-pane-mirror/)
    await expect(page.locator('[data-pane-label="secondary"]')).toHaveText('Device B · Mirror of A')
    await expect(secondary.locator('#devName')).toHaveText(
      await primary.locator('#devName').innerText(),
    )
    await expect(primary.locator('#logsList .log-row').first()).toContainText('dual log visible')
    await expect(secondary.locator('#logsList .log-row').first()).toContainText('dual log visible')

    const devices = await page.evaluate(async () => (await fetch('/api/devices')).json())
    expect(devices.secondary).toBeNull()

    await primary.locator('#devBtn').click()
    await primary.locator('#devList button').filter({ hasText: 'UDID-E2E-B' }).click()
    await expect(page.locator('[data-pane-label="secondary"]')).toHaveText('Device B')
    await expect(secondary.locator('body')).not.toHaveClass(/dual-pane-mirror/)
    await expect(primary.locator('#devName')).toContainText('iPhone 15 Pro Max')
    await expect(secondary.locator('#devName')).toContainText('iPhone 14 Pro Max')
  })

  test('also mirrors B when A switches to the device already selected there', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#recLabel')).toHaveText('LIVE')
    await page.locator('#dualToggle').click()

    const primary = page.locator('iframe[data-pane="primary"]').contentFrame()
    const secondary = page.locator('iframe[data-pane="secondary"]').contentFrame()
    await secondary.locator('#devBtn').click()
    await secondary.locator('#devList button').filter({ hasText: 'UDID-E2E-B' }).click()
    await expect(secondary.locator('#devName')).toContainText('iPhone 15 Pro Max')

    await primary.locator('#devBtn').click()
    await primary.locator('#devList button').filter({ hasText: 'UDID-E2E-B' }).click()
    await expect(page.locator('[data-pane-label="secondary"]')).toHaveText('Device B · Mirror of A')
    await expect(secondary.locator('body')).toHaveClass(/dual-pane-mirror/)
    await expect(secondary.locator('#devName')).toHaveText(
      await primary.locator('#devName').innerText(),
    )
  })

  test('coordinates iOS availability, sticky cards and equal panel scale', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await expect(page.locator('#recLabel')).toHaveText('LIVE')

    await page.locator('#dualToggle').click()
    const primary = page.locator('iframe[data-pane="primary"]').contentFrame()
    const secondary = page.locator('iframe[data-pane="secondary"]').contentFrame()

    await expect(primary.locator('#devName')).not.toHaveText('Waiting for device…')
    await secondary.locator('#devBtn').click()
    await secondary.locator('#devList button').filter({ hasText: 'UDID-E2E-B' }).click()

    const notice = page.locator('#dualPlatformNotice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Frame-time jank, p90, p99, Network Data and Data Inspector')
    await expect(primary.locator('[data-cap="frameTimes"]')).toBeHidden()
    await expect(secondary.locator('[data-cap="frameTimes"]')).toBeHidden()
    await expect(primary.locator('#appLaunched')).toBeHidden()
    await expect(secondary.locator('#appLaunched')).toBeHidden()
    await expect(secondary.locator('#logsList .log-row').first()).toContainText('dual log visible')

    const primaryCard = await primary.locator('#devSelect').boundingBox()
    const secondaryCard = await secondary.locator('#devSelect').boundingBox()
    expect(primaryCard).not.toBeNull()
    expect(secondaryCard).not.toBeNull()
    expect(Math.abs(primaryCard!.width - secondaryCard!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(primaryCard!.y - secondaryCard!.y)).toBeLessThanOrEqual(1)

    const primaryApp = await primary.locator('#appSelect').boundingBox()
    const secondaryApp = await secondary.locator('#appSelect').boundingBox()
    expect(primaryApp).not.toBeNull()
    expect(secondaryApp).not.toBeNull()
    expect(Math.abs(primaryApp!.y - secondaryApp!.y)).toBeLessThanOrEqual(1)

    await page.locator('#dualStickyDevices').check()
    await primary.locator('footer').scrollIntoViewIfNeeded()
    await secondary.locator('footer').scrollIntoViewIfNeeded()
    await expect(primary.locator('.dual-sticky-card')).toHaveClass(/visible/)
    await expect(secondary.locator('.dual-sticky-card')).toHaveClass(/visible/)

    await expect(page.locator('#dualSettingsToggle')).toBeVisible()
    await page.locator('#dualSettingsToggle').click()
    await expect(page.locator('#dualSettingsDrawer')).toBeVisible()
    await expect(page.locator('#dualComparisonExport')).toContainText('Export Comparison Report')
    await expect(page.locator('#dualAppFilter')).toBeVisible()
    await expect(page.locator('#dualSampling')).toBeVisible()
    await expect(page.locator('#dualTargetFps')).toBeVisible()
    await page.locator('.dual-settings-close').click()

    await primary.locator('#menuBtn').click()
    await expect(primary.locator('#panelAppearance')).toBeVisible()
    await expect(primary.locator('#exportRow')).toBeHidden()
  })
})

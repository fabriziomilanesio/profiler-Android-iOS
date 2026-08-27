import { expect, test } from '@playwright/test'

test.describe('dual comparison QoL', () => {
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
    await expect(notice).toContainText('Frame-time jank, p90 and p99 are unavailable')
    await expect(primary.locator('[data-cap="frameTimes"]')).toBeHidden()
    await expect(secondary.locator('[data-cap="frameTimes"]')).toBeHidden()

    const primaryCard = await primary.locator('#devSelect').boundingBox()
    const secondaryCard = await secondary.locator('#devSelect').boundingBox()
    expect(primaryCard).not.toBeNull()
    expect(secondaryCard).not.toBeNull()
    expect(Math.abs(primaryCard!.width - secondaryCard!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(primaryCard!.y - secondaryCard!.y)).toBeLessThanOrEqual(1)

    await page.locator('#dualStickyDevices').check()
    await primary.locator('footer').scrollIntoViewIfNeeded()
    await secondary.locator('footer').scrollIntoViewIfNeeded()
    await expect(primary.locator('.dual-sticky-card')).toHaveClass(/visible/)
    await expect(secondary.locator('.dual-sticky-card')).toHaveClass(/visible/)
  })
})

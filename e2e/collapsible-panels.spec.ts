import { expect, test } from '@playwright/test'

test('los paneles de métricas empiezan abiertos y se pueden plegar', async ({ page }) => {
  await page.goto('/')

  const panels = page.locator('.collapse-toggle')
  await expect(panels).toHaveCount(6)
  for (let i = 0; i < 6; i++) {
    await expect(panels.nth(i)).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(page.locator('#logsBody')).toBeVisible()

  const fps = panels.filter({ hasText: 'FPS' })
  await fps.click()
  await expect(fps).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#fpsNum')).toBeHidden()

  await fps.click()
  await expect(fps).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#fpsNum')).toBeVisible()
})

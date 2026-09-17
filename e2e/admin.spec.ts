import { test, expect } from '@playwright/test'

test('administrator can register a device and change lifecycle with a reason', async ({ page }) => {
  test.skip(!process.env.E2E_ADMIN_SESSION_TOKEN, 'Set TEST_DATABASE_URL for the authenticated E2E scenario.')
  await page.context().addCookies([{
    name: 'sharework_session',
    value: process.env.E2E_ADMIN_SESSION_TOKEN ?? '',
    url: 'http://127.0.0.1:5173',
    httpOnly: true,
    sameSite: 'Lax',
  }])

  await page.goto('/')
  await expect(page.getByRole('button', { name: '管理工作台' })).toBeVisible()
  await page.getByRole('button', { name: '管理工作台' }).click()
  await expect(page.getByRole('heading', { name: '管理工作台' })).toBeVisible()

  const deviceName = process.env.E2E_ADMIN_DEVICE ?? 'E2E Admin Device'
  await page.getByLabel('设备名称').fill(deviceName)
  await page.getByLabel('类别').fill('E2E')
  await page.getByRole('button', { name: '登记设备' }).click()
  await expect(page.getByRole('status')).toContainText('设备已登记')

  const deviceRow = page.locator('.admin-device-row').filter({ hasText: deviceName })
  await expect(deviceRow).toBeVisible()
  await deviceRow.getByRole('combobox').selectOption('maintenance')
  await deviceRow.getByPlaceholder('状态变更原因（必填）').fill('E2E 维护检查')
  await deviceRow.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('status')).toContainText('设备状态已更新')
})

import { test, expect } from '@playwright/test'

test('authenticated member can borrow, return and reserve through the real UI', async ({ page }) => {
  test.skip(!process.env.E2E_SESSION_TOKEN, 'Set TEST_DATABASE_URL for the authenticated E2E scenario.')
  await page.context().addCookies([{
    name: 'sharework_session',
    value: process.env.E2E_SESSION_TOKEN ?? '',
    url: 'http://127.0.0.1:4116',
    httpOnly: true,
    sameSite: 'Lax',
  }])

  await page.goto('/')
  const borrowDevice = new RegExp(process.env.E2E_BORROW_DEVICE ?? 'E2E Camera')
  const reservationDevice = new RegExp(process.env.E2E_RESERVATION_DEVICE ?? 'E2E Light')
  await expect(page.getByRole('button', { name: borrowDevice })).toBeVisible()
  await page.getByRole('button', { name: borrowDevice }).click()
  const dueInput = page.getByLabel('借用至')
  await dueInput.fill('2099-01-01T12:00')
  await expect(dueInput).toHaveValue('2099-01-01T12:00')
  await page.getByRole('button', { name: '借用这件设备' }).click()
  await expect(page.getByRole('status')).toContainText('借用已登记')

  await page.getByRole('button', { name: /我的记录/ }).click()
  await expect(page.getByText(process.env.E2E_BORROW_DEVICE ?? 'E2E Camera')).toBeVisible()
  await page.getByRole('button', { name: '确认归还' }).click()
  const returnDialog = page.getByRole('dialog')
  await expect(returnDialog).toContainText('确认归还')
  await returnDialog.getByLabel('归还说明（可选）').fill('E2E 归还说明：配件齐全。')
  await returnDialog.getByRole('button', { name: '确认归还' }).click()
  await expect(page.getByRole('status')).toContainText('归还已确认')

  await page.getByRole('button', { name: '设备目录' }).click()
  await page.getByRole('button', { name: reservationDevice }).click()
  const startInput = page.getByLabel('开始')
  const endInput = page.getByLabel('结束')
  await startInput.fill('2099-02-01T10:00')
  await endInput.fill('2099-02-01T12:00')
  await expect(startInput).toHaveValue('2099-02-01T10:00')
  await expect(endInput).toHaveValue('2099-02-01T12:00')
  await page.getByRole('button', { name: '创建预约' }).click()
  await expect(page.getByRole('status')).toContainText('预约已创建')
})

import { test, expect } from '@playwright/test'

test('server health check is reachable', async ({ request }) => {
  const response = await request.get('/healthz')

  expect(response.ok()).toBe(true)
  await expect(response).toBeOK()
})

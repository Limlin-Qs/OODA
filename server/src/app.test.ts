import { buildApp } from './app.js'
import { describe, expect, it } from 'vitest'

describe('server baseline', () => {
  it('serves the health check', async () => {
    const app = buildApp()
    const response = await app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })

    await app.close()
  })
})

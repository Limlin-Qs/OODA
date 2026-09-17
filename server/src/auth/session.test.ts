import { describe, expect, it } from 'vitest'
import {
  createOpaqueToken,
  hashOpaqueToken,
  parseCookies,
  serializeCookie,
} from './session.js'

describe('opaque server sessions', () => {
  it('hashes a token without exposing the token in persistence values', () => {
    const token = createOpaqueToken()
    const hash = hashOpaqueToken(token)

    expect(hash).not.toBe(token)
    expect(hash).toHaveLength(64)
    expect(hashOpaqueToken(token)).toBe(hash)
  })

  it('parses and serializes HttpOnly cookies', () => {
    const cookie = serializeCookie('session', 'token/value', {
      maxAge: 3600,
      secure: true,
    })
    const parsed = parseCookies(`${cookie}; other=value`)

    expect(parsed.get('session')).toBe('token/value')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
  })
})

import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const sessionCookieName = 'sharework_session'
export const loginStateCookieName = 'sharework_login_state'

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSessionId(): string {
  return randomUUID()
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    cookies.set(name, decodeURIComponent(value))
  }

  return cookies
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; secure?: boolean } = {},
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
  ]
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`)
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}

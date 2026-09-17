import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export interface OidcConfig {
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

interface ProviderMetadata {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

interface TokenResponse {
  access_token: string
  id_token?: string
  token_type: string
}

export interface OidcIdentity {
  subject: string
  displayName: string
}

export interface LoginRequest {
  state: string
  nonce: string
  codeVerifier: string
  authorizationUrl: string
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function createNonce(): string {
  return base64Url(randomBytes(24))
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OIDC response is missing ${field}.`)
  }
  return value
}

export function readOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | null {
  const issuerUrl = env.OIDC_ISSUER_URL
  const clientId = env.OIDC_CLIENT_ID
  const clientSecret = env.OIDC_CLIENT_SECRET
  const redirectUri = env.OIDC_REDIRECT_URI

  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) return null

  return { issuerUrl, clientId, clientSecret, redirectUri }
}

export class OidcClient {
  private readonly config: OidcConfig
  private metadata: ProviderMetadata | null = null
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null

  constructor(config: OidcConfig) {
    this.config = config
  }

  private async discover(): Promise<ProviderMetadata> {
    if (this.metadata) return this.metadata
    const discoveryUrl = `${this.config.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`
    const response = await fetch(discoveryUrl)
    if (!response.ok) throw new Error(`OIDC discovery failed with ${response.status}.`)
    this.metadata = (await response.json()) as ProviderMetadata
    return this.metadata
  }

  async createLoginRequest(): Promise<LoginRequest> {
    const metadata = await this.discover()
    const state = base64Url(randomBytes(32))
    const nonce = createNonce()
    const { verifier, challenge } = createPkcePair()
    const url = new URL(metadata.authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()

    return {
      state,
      nonce,
      codeVerifier: verifier,
      authorizationUrl: url.toString(),
    }
  }

  async exchangeCode(code: string, request: LoginRequest): Promise<OidcIdentity> {
    const metadata = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: request.codeVerifier,
    })
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) throw new Error(`OIDC token exchange failed with ${response.status}.`)

    const tokenResponse = (await response.json()) as TokenResponse
    const idToken = requireString(tokenResponse.id_token, 'id_token')
    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri))
    const verified = await jwtVerify(idToken, this.jwks, {
      issuer: metadata.issuer,
      audience: this.config.clientId,
    })
    if (verified.payload.nonce !== request.nonce) {
      throw new Error('OIDC nonce validation failed.')
    }

    const payload: JWTPayload = verified.payload
    const subject = requireString(payload.sub, 'sub')
    const name = typeof payload.name === 'string' ? payload.name : subject

    return { subject, displayName: name }
  }
}

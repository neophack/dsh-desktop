/** Generation-scoped capability separating Electron from ordinary browsers. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'

/** Header attached only by the Electron renderer's native network session. */
export const DESKTOP_RENDERER_ACCESS_HEADER = 'x-dsh-desktop-renderer'
export const DESKTOP_BROWSER_ACCESS_COOKIE = 'dsh_desktop_session'

const ACCESS_TOKEN_BYTES = 32
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const DESKTOP_MARKER_PREFIX = 'dsh-desktop-'

/** Header value retained only in main-process and Host-generation memory. */
export interface DesktopRendererAccessHeader {
  readonly name: typeof DESKTOP_RENDERER_ACCESS_HEADER
  readonly value: string
}

/** Browser-access policy fixed for one Desktop Host generation. */
export interface DesktopBrowserAccess {
  /** Whether marker-free ordinary-browser traffic may currently reach the Web carrier. */
  readonly ordinaryBrowserEnabled: boolean
  /** Ephemeral capability proving that a request came from the Electron renderer. */
  readonly rendererHeader: DesktopRendererAccessHeader
  /** Root URL carrying the one-time browser-session bootstrap token. */
  authenticatedUrl(baseUrl: string): string
  /** Change ordinary-browser access without rebuilding the Host generation. */
  setOrdinaryBrowserEnabled(enabled: boolean): void
}

/** Request classes understood by the Desktop-owned WebServer gate. */
export type DesktopBrowserAccessDecision = 'renderer' | 'browser' | 'browser-auth' | 'denied'

/** Create one unpredictable renderer capability for a Desktop Host generation. */
export function createDesktopBrowserAccess(
  ordinaryBrowserEnabled: boolean,
  token: string = randomBytes(ACCESS_TOKEN_BYTES).toString('base64url'),
): DesktopBrowserAccess {
  if (typeof ordinaryBrowserEnabled !== 'boolean') {
    throw new TypeError('dsh-plugin-desktop: ordinary browser access must be a boolean')
  }
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    throw new TypeError('dsh-plugin-desktop: renderer access token must be 32 base64url bytes')
  }
  let enabled = ordinaryBrowserEnabled
  return Object.freeze({
    get ordinaryBrowserEnabled() { return enabled },
    rendererHeader: Object.freeze({
      name: DESKTOP_RENDERER_ACCESS_HEADER,
      value: token,
    }),
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl)
      url.pathname = '/'
      url.search = ''
      url.hash = ''
      url.searchParams.set('token', token)
      return url.href
    },
    setOrdinaryBrowserEnabled(next: boolean) {
      if (typeof next !== 'boolean') {
        throw new TypeError('dsh-plugin-desktop: ordinary browser access must be a boolean')
      }
      enabled = next
    },
  })
}

function exactHeaderValue(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[DESKTOP_RENDERER_ACCESS_HEADER]
  return typeof value === 'string' ? value : undefined
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || !ACCESS_TOKEN_PATTERN.test(actual) || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

function browserCookieToken(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.cookie
  if (typeof raw !== 'string') return undefined
  let found: string | undefined
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== DESKTOP_BROWSER_ACCESS_COOKIE) continue
    if (found !== undefined) return undefined
    found = part.slice(separator + 1).trim()
  }
  return found
}

function browserLaunchToken(rawUrl: string | undefined): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl ?? '/', 'http://dsh.invalid')
  } catch {
    return undefined
  }
  const tokens = url.searchParams.getAll('token')
  if (url.pathname !== '/' || tokens.length !== 1 || [...url.searchParams.keys()].length !== 1) return undefined
  return tokens[0]
}

/** Whether an uncredentialed URL is attempting to activate Desktop-only client effects. */
export function desktopBrowserUrlHasRendererMarkers(rawUrl: string | undefined): boolean {
  let url: URL
  try {
    url = new URL(rawUrl ?? '/', 'http://dsh.invalid')
  } catch {
    return true
  }
  return [...url.searchParams.keys()].some(key => key.startsWith(DESKTOP_MARKER_PREFIX))
}

/** Classify one HTTP or upgrade request without exposing the renderer token. */
export function decideDesktopBrowserAccess(
  access: DesktopBrowserAccess,
  request: { readonly headers: IncomingHttpHeaders; readonly url?: string | undefined },
): DesktopBrowserAccessDecision {
  if (sameToken(exactHeaderValue(request.headers), access.rendererHeader.value)) return 'renderer'
  if (!access.ordinaryBrowserEnabled || desktopBrowserUrlHasRendererMarkers(request.url)) return 'denied'
  if (sameToken(browserLaunchToken(request.url), access.rendererHeader.value)) return 'browser-auth'
  return sameToken(browserCookieToken(request.headers), access.rendererHeader.value) ? 'browser' : 'denied'
}

/** Exchange an authenticated root URL for an HttpOnly browser-session cookie. */
export function authorizeDesktopBrowserIndex(
  access: DesktopBrowserAccess,
  request: { readonly method?: string | undefined; readonly headers: IncomingHttpHeaders; readonly url?: string | undefined },
  response: Pick<ServerResponse, 'setHeader' | 'writeHead' | 'end'>,
): boolean {
  if (request.method !== 'GET' || decideDesktopBrowserAccess(access, request) !== 'browser-auth') return false
  response.setHeader(
    'set-cookie',
    `${DESKTOP_BROWSER_ACCESS_COOKIE}=${access.rendererHeader.value}; Path=/; HttpOnly; SameSite=Strict`,
  )
  response.setHeader('cache-control', 'no-store')
  response.setHeader('location', '/')
  response.writeHead(302)
  response.end()
  return true
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned request gate present only in a Desktop Host generation. */
    desktopBrowserAccess: DesktopBrowserAccess
  }
}

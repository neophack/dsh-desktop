/**
 * Test doubles for test/login-flow.mjs.
 *
 * The built Host bundle (lib/index.js) keeps its runtime deps external, three
 * of which only exist inside the DSH Desktop app: 'electron', the credentials
 * service façade and schemastery. `prepareStubs()` writes self-contained
 * stand-ins to a temp dir; `patchHostBundle(source)` rewrites the bundle's
 * import specifiers to them, so the flow test can run anywhere, headless,
 * with no profile node_modules and no module-loader hooks.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const electronState = (globalThis.__NEWAPI_TEST_ELECTRON__ ??= { windows: [], jar: new Map(), jarGets: 0 })

const electronStub = `
const S = globalThis.__NEWAPI_TEST_ELECTRON__
class BrowserWindow {
  constructor(options) {
    this.options = options
    this.url = ''
    this.destroyed = false
    this.listeners = new Map()
    this.webContents = {
      openDevTools() {},
      on(event, listener) {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
        return this
      },
      listeners: new Map(),
    }
    S.windows.push(this)
  }
  on(event, listener) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }
  async loadURL(url) { this.url = url }
  close() {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of this.listeners.get('closed') ?? []) listener()
  }
  isDestroyed() { return this.destroyed }
}
export const session = {
  defaultSession: {
    cookies: {
      async get(filter) {
        S.jarGets += 1
        const url = new URL(filter.url)
        const origin = url.origin
        const trim = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
        const path = trim(url.pathname) || '/'
        // RFC 6265 path-match, like Chromium's cookies.get(url) filter.
        return [...(S.jar.get(origin) ?? [])].filter((cookie) => {
          const cookiePath = trim(cookie.path ?? '/') || '/'
          return path === cookiePath || path.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/')
        })
      },
    },
  },
}
export { BrowserWindow }
`

const credentialsStub = `
export const credentialRef = (name) => ({ name })
`

const schemasteryStub = `
const chain = new Proxy(function zchain() {}, {
  get(target, prop) {
    if (prop === 'default') return () => ({})
    if (typeof prop === 'symbol') return undefined
    return chain
  },
  apply() { return chain },
})
export default { object: () => ({}), string: () => chain, boolean: () => chain, number: () => chain }
`

let stubDir
const stubUrl = (name, source) => {
  stubDir ??= mkdirSync(join(tmpdir(), `newapi-login-flow-${String(process.pid)}`), { recursive: true })
  const path = join(stubDir, name)
  writeFileSync(path, source, 'utf8')
  return pathToFileURL(path).href
}

/** Rewrite the external app-only imports of the host bundle to test doubles. */
export function patchHostBundle(source) {
  return source
    .replaceAll('from "@deepseek-ai/dsh-credentials"', `from "${stubUrl('credentials-stub.mjs', credentialsStub)}"`)
    .replaceAll('from "@deepseek-ai/schemastery"', `from "${stubUrl('schemastery-stub.mjs', schemasteryStub)}"`)
    .replaceAll('import("electron")', `import("${stubUrl('electron-stub.mjs', electronStub)}")`)
}


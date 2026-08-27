/**
 * Client bundle shape check: the file must be loadable through the DSH web
 * module loader shape `window.__ModuleLoader__.load({id, factory})` — i.e. a
 * CJS factory `(require, module, exports)` whose exports carry the client
 * Cordis face (inject + apply). Stubs satisfy the externals. Driving apply(ctx)
 * must register BOTH slot contributions: the settings.section page and the
 * sidebar.footer.action login button.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

if (source.includes('\uFFFD')) fail('client.js contains U+FFFD replacement characters')

const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: undefined }),
  Fragment: 'Fragment',
}
const require_ = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? false : () => null) })
  }
  if (id === 'cordis' || id === '@deepseek-ai/dsh-client-runtime' || id === '@deepseek-ai/dsh-client-runtime/client') {
    return { effect: () => () => {} }
  }
  fail(`unexpected module import "${id}"`)
  return undefined
}

/** slot key -> registration options captured while apply(ctx) ran */
const registrations = new Map()
let pendingKey = '__none__'
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  get: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
  slots: {
    inject: (key, callback) => {
      pendingKey = key
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.set(pendingKey, { ...options, __component: component })
      return () => {}
    },
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
}

let exports_
let captured
try {
  // Browser-platform bundle; provide the minimal browser globals it may touch.
  globalThis.window = globalThis.window ?? { location: { origin: 'http://127.0.0.1' } }
  window.__ModuleLoader__ = { load: (definition) => { captured = definition } }
  // eslint-disable-next-line no-new-func
  new Function(source)()
  if (captured?.id !== 'dsh-plugin-newapi') fail(`loader id wrong: ${String(captured?.id)}`)
  exports_ = captured.factory(require_)
} catch (error) {
  fail(`factory threw: ${error.message}`)
}

const face = exports_?.default ?? exports_
if (typeof face?.apply !== 'function') fail('exports.default.apply is missing')
if (!Array.isArray(face?.inject) || !face.inject.includes('slots') || !face.inject.includes('connection')) {
  fail(`inject list wrong: ${JSON.stringify(face?.inject)}`)
}

// Drive the Cordis client lifecycle to verify both slot registrations.
face.apply(ctx)

const section = registrations.get('settings.section')
if (section?.id !== 'newapi') fail(`settings.section registration id wrong: ${JSON.stringify(section)}`)

const footer = registrations.get('sidebar.footer.action')
if (footer?.id !== 'newapi-login') fail(`sidebar.footer.action registration id wrong: ${JSON.stringify(footer)}`)
if (typeof section.__component !== 'function') fail('settings.section registration carries no component')
if (typeof footer.__component !== 'function') fail('sidebar.footer.action registration carries no component')

console.log('client bundle: loader-shape OK')
console.log('  inject =', face.inject.join('+'))
console.log('  settings.section       id =', section.id, '| order =', section.order)
console.log('  sidebar.footer.action  id =', footer.id, '| order =', footer.order)

/**
 * Client bundle shape check: the file must be loadable through the DSH web
 * module loader shape `window.__ModuleLoader__.load({id, factory})` — i.e. a
 * CJS factory `(require, module, exports)` whose exports carry the client
 * Cordis face (inject + apply). Stubs satisfy the externals. Driving apply(ctx)
 * must register the ONE slot contribution this client half owns: the
 * `settings.section` page sitting right after the NewAPI entry (order 16,
 * between the order-15 sections and agent presets' 20), editing the
 * `websearch` settings namespace through a bound settingsScope.
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
  useState: (init) => [init instanceof Function ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  Fragment: 'Fragment',
}
const require_ = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  fail(`unexpected module import "${id}"`)
  return undefined
}

let loaded = undefined
const windowStub = {
  __ModuleLoader__: {
    load: (definition) => {
      if (definition.id !== 'dsh-plugin-websearch') fail(`unexpected module id ${JSON.stringify(definition.id)}`)
      // The factory returns its populated module.exports (the esbuild CJS body
      // reassigns its own `module`, so the caller's stub object stays empty).
      loaded = definition.factory(require_, { exports: {} }, {})
    },
  },
}
const load = new Function('window', 'require_', `${source}\nreturn window.__ModuleLoader__`)
load(windowStub, require_)
if (loaded === undefined) fail('module loader never ran the factory')
if (typeof loaded !== 'object' || loaded === null) fail('factory must export an object (no default export)')
if (typeof loaded.inject !== 'object' || !Array.isArray(loaded.inject)) fail('client entry must export the inject array')
for (const service of ['slots', 'locale', 'settingsScope']) {
  if (!loaded.inject.includes(service)) fail(`client inject must declare ${service}`)
}
if (typeof loaded.apply !== 'function') fail('client entry must export apply(ctx)')

/** slot key -> registration options captured while apply(ctx) ran */
const registrations = new Map()
let pendingKey = '__none__'
const bindCalls = []
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  settingsScope: {
    bind: (spec) => {
      bindCalls.push(spec)
      return {
        getSnapshot: () => ({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
      }
    },
    describe: () => ({
      getSnapshot: () => ({ status: 'idle', view: undefined }),
      subscribe: () => () => {},
      ensure: () => {},
    }),
  },
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
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
}

loaded.apply(ctx)

if (!registrations.has('settings.section')) fail('apply must register a settings.section entry')
const section = registrations.get('settings.section')
if (section.id !== 'websearch') fail(`settings.section id must be 'websearch', got ${JSON.stringify(section.id)}`)
if (section.order !== 16) fail(`settings.section order must be 16 (right after NewAPI's 15), got ${JSON.stringify(section.order)}`)
if (typeof section.label !== 'function') fail('settings.section label must be a locale closure')
if (typeof section.__component !== 'function') fail('settings.section component must be a function')

if (bindCalls.length !== 1) fail('apply must bind exactly one settings scope')
if (bindCalls[0].namespace !== 'websearch') fail(`scope must bind the 'websearch' namespace, got ${JSON.stringify(bindCalls[0].namespace)}`)

const face = section.inject()
if (typeof face.t !== 'function' || face.scope === undefined || face.describe === undefined) {
  fail('the section inject face must carry the locale reader, the bound scope, and the describe face')
}
const rendered = section.__component(face)
if (rendered !== null && rendered !== undefined) fail('the page renders a loading placeholder before the section arrives')

console.log('websearch client shape: all checks passed')

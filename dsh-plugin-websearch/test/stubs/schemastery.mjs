/**
 * Test stub for '@deepseek-ai/schemastery': the plugin entry only builds the
 * Config schema object (apply never evaluates it at test time), so a minimal
 * object() suffices to import the entry module outside the DSH profile.
 */
function field(options) {
  return { ...options }
}

const z = {
  object: (shape) => ({ shape }),
  string: () => {
    const f = field({ type: 'string' })
    f.default = (value) => field({ type: 'string', default: value })
    f.role = () => f
    return f
  },
  number: () => {
    const f = field({ type: 'number' })
    f.step = () => f
    f.min = () => f
    f.default = (value) => field({ type: 'number', default: value })
    return f
  },
}

export default z

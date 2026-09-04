/**
 * Test stub for '@deepseek-ai/dsh-launch-environment': tests that need env
 * fallbacks drive the values through this module's exported `values` map.
 */
export const values = new Map()

export function launchEnvironmentOf() {
  return {
    get: (name) => values.get(name),
  }
}

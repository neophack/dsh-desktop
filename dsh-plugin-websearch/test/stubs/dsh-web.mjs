/**
 * Test stub for '@deepseek-ai/dsh-web': the only runtime value the provider
 * imports is WebError, whose observable shape is { message, code, cause } —
 * the seam propagates provider errors without instanceof checks, so a local
 * class exercises every error path faithfully without the real package.
 */
export class WebError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

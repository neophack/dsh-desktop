/**
 * Detect, once, whether this process can create filesystem symlinks without
 * elevation. Unprivileged symlink creation is denied on Windows unless
 * Developer Mode (or an elevated/admin token) is active, which many local
 * and sandboxed CI runs lack — while a POSIX user can always create one.
 * Tests that exercise "reject a symlinked path" security behavior need a
 * real symlink to exist first; skip them (rather than fail on an unrelated
 * EPERM) when this environment cannot create one at all.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let cached: boolean | undefined

export function canCreateSymlinks(): boolean {
  if (cached !== undefined) return cached
  const root = mkdtempSync(join(tmpdir(), 'dsh-symlink-capability-'))
  try {
    const target = join(root, 'target')
    writeFileSync(target, '')
    symlinkSync(target, join(root, 'link'), 'file')
    cached = true
  } catch {
    cached = false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return cached
}

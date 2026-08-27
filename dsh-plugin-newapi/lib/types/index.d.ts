/** Host Cordis plugin contract for dsh-plugin-newapi. */
import type { Context } from '@deepseek-ai/cordis'

export interface PluginConfig {
  route?: string
  apiKeyEnv?: string
  displayName?: string
}

export const name: string
export const inject: string[]
export function apply(ctx: Context, config?: PluginConfig): void

/**
 * Desktop delete affordance for the official DeepSeek provider on the Models
 * settings page.
 *
 * Upstream marks a shipped whole-namespace provider (`settingsPath: []`)
 * non-removable, so the official DeepSeek row renders Edit but no Delete
 * button. The desktop product treats the official route as user-managed (it
 * ships an EMPTY default catalog and the user adds models by hand), so this
 * occupant of the documented `settings.models.provider-card` extension seat
 * adds the missing button. "Delete" clears the user layer of `llm-deepseek`
 * (every added model and override) and removes the stored DEEPSEEK_API_KEY
 * credential, returning the provider to the empty desktop base: no models in
 * the chat selector, no key left behind. Upstream is never edited; a profile
 * without this client plugin simply gets the shipped row back.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the provider-card SlotMap merge (payload shape stays structural
// below, matching how this package consumes other upstream client faces).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'

/** The settings namespace (and provider-card dispatch key) this button serves. */
const DEEPSEEK_NS = 'llm-deepseek'

/** The credential reference the official DeepSeek adapter resolves its key through. */
const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Locale namespace of this surface's copy. */
const DESKTOP_MODELS_LOCALE_NAMESPACE = 'desktop-models'

const zh = {
  removeDeepSeek: '删除 DeepSeek',
  removeDeepSeekConfirm: '将清除已添加的 DeepSeek 模型和已保存的 API 密钥, 恢复为默认 (不添加任何模型)。确定删除?',
  removeDeepSeekDone: '已删除 DeepSeek 的模型与密钥。',
  removeDeepSeekFailed: '删除失败: {message}',
}

const en: Record<keyof typeof zh, string> = {
  removeDeepSeek: 'Delete DeepSeek',
  removeDeepSeekConfirm: 'This clears every DeepSeek model you added and the stored API key, back to the default (no models). Delete?',
  removeDeepSeekDone: 'Deleted the DeepSeek models and key.',
  removeDeepSeekFailed: 'Delete failed: {message}',
}

type ModelsLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Models-page DeepSeek delete-affordance copy. */
    'desktop-models': ModelsLocaleKey
  }
}

type Translate = (key: ModelsLocaleKey, params?: Record<string, string>) => string

/** Owner share the Models section passes to every provider-card occupant. */
interface ProviderCardOwnerProps {
  provider: {
    readonly provider: string
    readonly displayName: string
    readonly settingsNs: string
    readonly settingsPath: readonly string[]
  }
  /** Whether any layer configures this provider; false on the add-provider draft. */
  configured: boolean
  keyConfigured: boolean
}

/**
 * Register the delete affordance on the official DeepSeek provider card.
 * @param ctx - browser Cordis context carrying the slots, locale, and remote services.
 * @returns the disposer the caller wires into ctx.effect.
 */
export function applyDeepSeekProviderDelete(ctx: ClientContext): () => void {
  const t: Translate = (key, params) =>
    ctx.locale.bind(DESKTOP_MODELS_LOCALE_NAMESPACE)(key, params)
  ctx.effect(
    () => ctx.locale.register(DESKTOP_MODELS_LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-desktop: models-page delete dictionaries',
  )

  /** Run the deletion: key first (a later failure stays retryable), then the user layer. */
  const deleteNow = async (): Promise<string | undefined> => {
    try {
      await ctx.remote.credentials.unset(DEEPSEEK_API_KEY_REF)
    } catch {
      // The settings clear is the load-bearing half; an unknown credential
      // reference must not block deleting the models.
    }
    try {
      const written = await ctx.remote.settings.mutate(DEEPSEEK_NS, [{ op: 'unset', path: [] }], undefined)
      return written.ok ? undefined : written.error.message
    } catch (error) {
      return String(error)
    }
  }

  /** One danger button on the DeepSeek row's extension area. */
  const DeepSeekProviderDelete = (props: ProviderCardOwnerProps): ReactElement | null => {
    const [busy, setBusy] = useState(false)
    const [failure, setFailure] = useState<string | undefined>(undefined)
    const [done, setDone] = useState(false)
    // Only the saved shipped row: the add-provider draft dispatches the same
    // slot with `configured: false` and gets nothing.
    if (
      props.provider.settingsNs !== DEEPSEEK_NS
      || props.provider.settingsPath.length > 0
      || !props.configured
    ) return null

    const remove = (): void => {
      if (busy || !window.confirm(t('removeDeepSeekConfirm'))) return
      setBusy(true)
      setFailure(undefined)
      setDone(false)
      void deleteNow().then((message) => {
        if (message !== undefined) setFailure(t('removeDeepSeekFailed', { message }))
        else setDone(true)
      }).finally(() => { setBusy(false) })
    }

    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, alignItems: 'center' }}>
        {failure !== undefined ? <span role="alert" style={{ color: 'rgb(220, 38, 38)', fontSize: 12 }}>{failure}</span> : null}
        {done ? <span role="status" style={{ fontSize: 12 }}>{t('removeDeepSeekDone')}</span> : null}
        <button
          type="button"
          disabled={busy}
          onClick={remove}
          style={{
            border: '1px solid rgba(220, 38, 38, 0.5)',
            background: 'transparent',
            color: 'rgb(220, 38, 38)',
            borderRadius: 6,
            padding: '4px 12px',
            cursor: busy ? 'default' : 'pointer',
            fontSize: 13,
          }}
        >
          {t('removeDeepSeek')}
        </button>
      </div>
    )
  }

  return ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(
    {
      name: 'settings.models.provider-card',
      key: DEEPSEEK_NS,
      registrant: 'dsh-plugin-desktop',
    },
    DeepSeekProviderDelete,
  ))
}

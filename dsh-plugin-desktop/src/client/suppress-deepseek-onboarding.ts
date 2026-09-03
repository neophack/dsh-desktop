/**
 * Desktop suppression of the official-DeepSeek first-run key prompt.
 *
 * The desktop product ships an EMPTY default DeepSeek catalog (see the
 * `llm-deepseek` config override in cordis.patch.yml): chat goes through the
 * configured provider, so prompting a first-run user for an official DeepSeek
 * API key has nothing to key it for. The prompt is an upstream client step in
 * the `settings.onboarding` slot (id `deepseek-official`); the documented way
 * to supersede a shipped occupant is to register the same id, which replaces
 * that cell. The slot registry rejects a same-id registration at an occupied
 * priority, so the suppression registers one priority below the shipped step
 * (the lowest order renders) to shadow it. The replacement renders nothing and completes itself on mount,
 * so the onboarding flow moves on (or ends). Upstream is never edited, and a
 * future profile without this client plugin simply gets the shipped step back.
 */

import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Shell props every onboarding step receives from the settings shell. */
interface OnboardingStepProps {
  /** Shell callback marking this step done; advances the onboarding flow. */
  complete?: () => void
}

/**
 * No-op occupant of the shipped `deepseek-official` onboarding cell: render
 * nothing and complete immediately (guarded against StrictMode
 * double-invoke; the shell's completion is idempotent regardless).
 */
export function SuppressDeepSeekKeyOnboarding(props: OnboardingStepProps): ReactElement | null {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    props.complete?.()
  }, [props.complete])
  return null
}

/**
 * Replace the shipped DeepSeek key onboarding step with a self-completing
 * no-op for this desktop generation.
 * @param ctx - browser Cordis context carrying the slots service.
 */
export function applyDeepSeekOnboardingSuppression(ctx: ClientContext): () => void {
  return ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'deepseek-official',
    // One below the shipped step's priority 0: the lowest order renders, and
    // the registry forbids re-registering an occupied (id, priority) cell.
    order: -1,
  }, SuppressDeepSeekKeyOnboarding))
}

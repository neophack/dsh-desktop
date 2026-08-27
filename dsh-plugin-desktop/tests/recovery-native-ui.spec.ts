import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecoveryTerminalAction } from '../src/native-ui/recovery/App.tsx'
import { RecoveryActionFooter, RecoveryActionLink } from '../src/native-ui/shared/RecoveryWindowPrimitives.tsx'
import { desktopRecoveryCopy } from '../src/recovery-copy.ts'

describe('Recovery native terminal action', () => {
  it('renders a labelled pill opposite each platform native-control group', () => {
    const copy = desktopRecoveryCopy('en')
    const mac = renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=true&platform=darwin',
    }))
    const windows = renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=true&platform=win32',
    }))

    expect(mac).toContain('right-3')
    expect(mac).not.toContain('left-3')
    expect(windows).toContain('left-3')
    expect(windows).not.toContain('right-3')
    for (const markup of [mac, windows]) {
      expect(markup).toContain('rounded-full')
      expect(markup).toContain('Open DSH Terminal')
      expect(markup).toContain('dsh-recovery://open-terminal')
    }
  })

  it('does not invent a title-row action without Desktop frame controls', () => {
    const copy = desktopRecoveryCopy('en')
    expect(renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=false&platform=darwin',
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(RecoveryTerminalAction, {
      copy,
      search: '?frame=true&platform=linux',
    }))).toBe('')
  })

  it('shares the Recovery footer layout while keeping a leading action on the left', () => {
    const markup = renderToStaticMarkup(createElement(
      RecoveryActionFooter,
      {
        leading: createElement(RecoveryActionLink, { children: 'Back', href: 'dsh-profile-selector://cancel' }),
        children: createElement(RecoveryActionLink, {
          children: 'Restart DSH Desktop',
          href: 'dsh-profile-selector://restart',
          variant: 'default',
        }),
      },
    ))

    expect(markup).toContain('mr-auto')
    expect(markup).toContain('dsh-profile-selector://cancel')
    expect(markup).toContain('dsh-profile-selector://restart')
  })
})

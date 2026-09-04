import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_LATEST_RELEASE_ENDPOINT,
  DESKTOP_RELEASES_LIST_ENDPOINT,
  MAX_RELEASE_RESPONSE_BYTES,
  checkForStableUpdate,
  checkForDesktopUpdate,
  compareSemVerVersions,
  desktopReleaseTagEndpoint,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'

function releaseResponse(tag: unknown, init: ResponseInit = {}): Response {
  return Response.json({ tag_name: tag }, init)
}

function releaseListResponse(tags: readonly unknown[], init: ResponseInit = {}): Response {
  return Response.json(tags.map(tag => ({ tag_name: tag })), init)
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('public Desktop version check', () => {
  it('isolates Beta checks on the releases list and rejects a stream without Beta tags', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return releaseListResponse(['v2.0.5', 'v2.0.4'])
    }
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request,
    })).resolves.toBeNull()
    expect(calls[0]?.url).toBe(DESKTOP_RELEASES_LIST_ENDPOINT)

    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request: async () => releaseListResponse(['v2.0.5-beta.2']),
    })).resolves.toMatchObject({ status: 'up-to-date' })
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request: async () => releaseResponse('v2.0.5-beta.3'),
    })).resolves.toBeNull()
  })

  it.each([
    ['newest beta by SemVer, not list order', ['v2.0.5-beta.2', 'v2.0.5-beta.10', 'v2.0.5-beta.3'], '2.0.5-beta.10'],
    ['ignores stable and non-beta tags', ['v2.1.0', 'v2.0.5-rc.1', 'v2.0.5-beta.4'], '2.0.5-beta.4'],
    ['ignores invalid SemVer tags', ['v2.0.5-beta.09', 'invalid', 'v2.0.5-beta.3'], '2.0.5-beta.3'],
  ])('discovers %s from the releases list', async (_case, tags, latest) => {
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request: async () => releaseListResponse(tags),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: latest,
    })
  })

  it('skips draft releases while discovering Beta tags', async () => {
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request: async () => Response.json([
        { tag_name: 'v2.0.6-beta.1', draft: true },
        { tag_name: 'v2.0.5-beta.3' },
      ]),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: '2.0.5-beta.3',
    })
  })

  it('allows an explicit Beta-to-stable selection even when stable is older', async () => {
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'stable',
      currentChannel: 'beta',
      allowDowngrade: true,
      request: async () => releaseResponse('v2.0.4'),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: '2.0.4',
    })
  })

  it('uses only the fixed no-cache GitHub endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return releaseResponse('v2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_LATEST_RELEASE_ENDPOINT)
    expect(calls[0]?.url).not.toContain('/releases/tags/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(headers.has('x-dsh-desktop-version')).toBe(false)
    expect(headers.has('x-dsh-desktop-channel')).toBe(false)
    expect(headers.has('x-dsh-desktop-installation-id')).toBe(false)
    expect(headers.has('if-none-match')).toBe(false)
  })

  it('exposes the fixed tag endpoint used to pin one checked release', () => {
    expect(desktopReleaseTagEndpoint('2.0.5-beta.2'))
      .toBe('https://api.github.com/repos/neophack/dsh-desktop/releases/tags/v2.0.5-beta.2')
  })

  it.each([
    ['2.0.0', 'v2.0.0'],
    ['2.0.1', 'v2.0.0'],
    ['2.0.0+installed', 'v2.0.0+release'],
  ])('reports no update for installed %s and release tag %s', async (currentVersion, tag) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => releaseResponse(tag),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion: tag.slice(1),
    })
  })

  it('lets a Beta installation discover the corresponding stable release', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.5-beta.2',
      currentChannel: 'beta',
      allowDowngrade: true,
      request: async () => releaseResponse('v2.0.5'),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: '2.0.5',
    })
  })

  it.each([
    ['prerelease tag', { tag_name: 'v2.1.0-rc.1' }],
    ['invalid SemVer tag', { tag_name: 'v2.01.0' }],
    ['missing tag', {}],
    ['non-string tag', { tag_name: 2 }],
    ['list response', ['v2.1.0']],
  ])('silently ignores a release document with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_RELEASE_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_RELEASE_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0', '2.0.0-01'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => releaseResponse('v2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

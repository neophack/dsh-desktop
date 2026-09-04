import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_LATEST_RELEASE_ENDPOINT,
  MAX_RELEASE_RESPONSE_BYTES,
  checkForStableUpdate,
  compareSemVerVersions,
  desktopReleaseRequestHeaders,
  desktopReleaseTagEndpoint,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'

function releaseResponse(tag: unknown, init: ResponseInit = {}): Response {
  return Response.json({ tag_name: tag }, init)
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
    expect(headers.get('user-agent')).toBe(desktopReleaseRequestHeaders()['User-Agent'])
    expect(headers.has('x-dsh-desktop-version')).toBe(false)
    expect(headers.has('x-dsh-desktop-channel')).toBe(false)
    expect(headers.has('x-dsh-desktop-installation-id')).toBe(false)
    expect(headers.has('if-none-match')).toBe(false)
  })

  it('exposes the fixed tag endpoint used to pin one checked release', () => {
    expect(desktopReleaseTagEndpoint('2.10.0'))
      .toBe('https://api.github.com/repos/neophack/dsh-desktop/releases/tags/v2.10.0')
  })

  it.each([
    ['2.0.0', 'v2.0.0'],
    ['2.0.1', 'v2.0.0'],
    ['2.0.0+installed', 'v2.0.0+release'],
    ['2.0.0', '2.0.0'],
  ])('reports no update for installed %s and release tag %s', async (currentVersion, tag) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => releaseResponse(tag),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion: tag.startsWith('v') ? tag.slice(1) : tag,
    })
  })

  it('compares release versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => releaseResponse('v10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
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
      request: async () => new Response(null, { status: 404 }),
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

  it.each(['2.0', 'v2.0.0', '2.0.0-rc.1'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => releaseResponse('v2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopReleaseTagEndpoint } from '../src/update-checker.ts'
import {
  MAX_UPDATE_DOWNLOAD_BYTES,
  UpdateDownloadError,
  desktopUpdateFilename,
  downloadDesktopUpdate,
  pendingDesktopUpdateArtifact,
  recordDesktopUpdateArtifact,
  resolveDesktopUpdateArtifact,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
} from '../src/update-download.ts'

const temporaryRoots: string[] = []

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-download-'))
  temporaryRoots.push(root)
  return root
}

function destinationPath(root: string, platform: DesktopDownloadPlatform, version: string): string {
  return join(root, desktopUpdateFilename(platform, version))
}

function assetUrl(version: string, name: string): string {
  return `https://github.com/neophack/dsh-desktop/releases/download/v${version}/${name}`
}

function releaseResponse(version: string, assets: readonly string[]): Response {
  return Response.json({
    tag_name: `v${version}`,
    assets: assets.map(name => ({ name, browser_download_url: assetUrl(version, name) })),
  })
}

/** Serve the release document for one version and one streamed response for every asset URL. */
function releaseServingRequest(
  version: string,
  assetNames: readonly string[],
  artifact: () => Response | Promise<Response>,
): UpdateArtifactRequest {
  return async url => url === desktopReleaseTagEndpoint(version)
    ? releaseResponse(version, assetNames)
    : artifact()
}

function dmgArtifact(): Uint8Array {
  const artifact = Buffer.alloc(1024, 0x5a)
  artifact.write('koly', artifact.byteLength - 512, 'ascii')
  return artifact
}

function windowsArtifact(): Uint8Array {
  const artifact = Buffer.alloc(512, 0)
  artifact.write('MZ', 0, 'ascii')
  artifact.writeUInt32LE(0x80, 0x3c)
  artifact.set([0x50, 0x45, 0x00, 0x00], 0x80)
  return artifact
}

function chunkedResponse(chunks: readonly Uint8Array[], headers: HeadersInit = {}): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }), { status: 200, headers })
}

async function expectFailure(
  promise: Promise<unknown>,
  code: UpdateDownloadError['code'],
): Promise<UpdateDownloadError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateDownloadError)
    expect(error).toMatchObject({ code })
    return error as UpdateDownloadError
  }
  throw new Error('Expected update download to fail.')
}

async function expectNoPartialFiles(directory: string): Promise<void> {
  const entries = await readdir(directory)
  expect(entries.filter(entry => entry.endsWith('.partial'))).toEqual([])
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop update installer download', () => {
  it('resolves the macOS DMG asset from the checked release and atomically completes it', async () => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      calls.push({ url, init })
      if (url === desktopReleaseTagEndpoint('2.1.0')) return releaseResponse('2.1.0', ['DSH.Desktop-2.1.0-universal.dmg'])
      return chunkedResponse([artifact.subarray(0, 333), artifact.subarray(333)])
    }

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.1.0',
      destinationPath: destinationPath(directory, 'darwin', '2.1.0'),
      request,
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.1.0-mac.dmg'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe(desktopReleaseTagEndpoint('2.1.0'))
    expect(calls[0]?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'follow' })
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe('application/vnd.github+json')
    expect(calls[1]?.url).toBe(assetUrl('2.1.0', 'DSH.Desktop-2.1.0-universal.dmg'))
    expect(calls[1]?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'follow' })
    await expectNoPartialFiles(directory)
  })

  it('accepts a Windows executable asset and never the portable archive', async () => {
    const directory = await temporaryDirectory()
    const artifact = windowsArtifact()

    const result = await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.2.0',
      destinationPath: destinationPath(directory, 'win32', '2.2.0'),
      request: releaseServingRequest(
        '2.2.0',
        ['DSH-Desktop-2.2.0-x64-Setup.exe', 'DSH-Desktop-2.2.0-x64-Portable.zip'],
        async () => chunkedResponse([artifact]),
      ),
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.2.0-windows.exe'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(directory)
  })

  it('prefers the expected architecture when a release carries several matching assets', async () => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const requested: string[] = []
    const request: UpdateArtifactRequest = async (url) => {
      if (url === desktopReleaseTagEndpoint('2.3.0')) {
        return releaseResponse('2.3.0', ['DSH.Desktop-2.3.0-x64.dmg', 'DSH.Desktop-2.3.0-universal.dmg'])
      }
      requested.push(url)
      return chunkedResponse([artifact])
    }

    await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.0',
      destinationPath: destinationPath(directory, 'darwin', '2.3.0'),
      request,
    })

    expect(requested).toEqual([assetUrl('2.3.0', 'DSH.Desktop-2.3.0-universal.dmg')])
  })

  it('accepts canonical stable SemVer build metadata in the private artifact path', async () => {
    const directory = await temporaryDirectory()
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.8.0+build',
      destinationPath: destinationPath(directory, 'darwin', '2.8.0+build'),
      request: releaseServingRequest('2.8.0+build', ['DSH.Desktop-2.8.0+build-universal.dmg'], async () => chunkedResponse([dmgArtifact()])),
    })

    expect(result).toBe(join(
      directory,
      'DSH-Desktop-2.8.0+build-mac.dmg',
    ))
  })

  it.each([
    ['a release tag different from the requested version', 'darwin', () => releaseResponse('9.9.9', ['DSH.Desktop-9.9.9-universal.dmg'])],
    ['a release without an installer asset', 'darwin', () => releaseResponse('2.3.0', ['DSH-Desktop-2.3.0-x64-Portable.zip'])],
    ['a release with ambiguous installer assets', 'win32', () => releaseResponse('2.3.0', ['DSH-Desktop-2.3.0-x64-Setup.exe', 'DSH-Desktop-2.3.0-arm64-Setup.exe'])],
    ['a malformed release document', 'darwin', () => new Response('{')],
  ] as const)('rejects %s without leaving a partial file', async (_label, platform, document) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform,
      version: '2.3.0',
      destinationPath: join(directory, desktopUpdateFilename(platform, '2.3.0')),
      request: async () => document(),
    }), 'invalid-artifact')
    await expectNoPartialFiles(directory)
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    ['darwin', new Uint8Array(1024)],
    ['win32', Object.assign(windowsArtifact(), { 0: 0 })],
    ['win32', Object.assign(windowsArtifact(), { 0x80: 0 })],
  ] as const)('rejects and removes an invalid %s artifact', async (platform, artifact) => {
    const directory = await temporaryDirectory()
    const asset = platform === 'darwin' ? 'DSH.Desktop-2.3.0-universal.dmg' : 'DSH-Desktop-2.3.0-x64-Setup.exe'
    await expectFailure(downloadDesktopUpdate({
      platform,
      version: '2.3.0',
      destinationPath: destinationPath(directory, platform, '2.3.0'),
      request: releaseServingRequest('2.3.0', [asset], async () => chunkedResponse([artifact])),
    }), 'invalid-artifact')
    await expectNoPartialFiles(directory)
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps an existing destination until its validated replacement is ready', async () => {
    const directory = await temporaryDirectory()
    const path = destinationPath(directory, 'win32', '2.3.1')
    const existing = Buffer.from('existing installer')
    await writeFile(path, existing)

    await expectFailure(downloadDesktopUpdate({
      platform: 'win32',
      version: '2.3.1',
      destinationPath: path,
      request: releaseServingRequest('2.3.1', ['DSH-Desktop-2.3.1-x64-Setup.exe'], async () => chunkedResponse([Buffer.alloc(128)])),
    }), 'invalid-artifact')
    expect(await readFile(path)).toEqual(existing)

    const replacement = windowsArtifact()
    await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.3.1',
      destinationPath: path,
      request: releaseServingRequest('2.3.1', ['DSH-Desktop-2.3.1-x64-Setup.exe'], async () => chunkedResponse([replacement])),
    })
    expect(await readFile(path)).toEqual(Buffer.from(replacement))
    await expectNoPartialFiles(directory)
  })

  it('rejects an unavailable release document with its HTTP status', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.4.0',
      destinationPath: destinationPath(directory, 'darwin', '2.4.0'),
      request: async () => new Response(null, { status: 404 }),
    }), 'http-status')
    await expectNoPartialFiles(directory)
  })

  it.each([
    ['an unsuccessful artifact response', async () => new Response(null, { status: 503 }), 'http-status'],
    ['a missing artifact response body', async () => new Response(null, { status: 200 }), 'empty-body'],
    ['a zero-byte artifact response body', async () => chunkedResponse([]), 'empty-body'],
  ] as const)('rejects %s without leaving a partial file', async (_label, response, code) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.4.0',
      destinationPath: destinationPath(directory, 'darwin', '2.4.0'),
      request: releaseServingRequest('2.4.0', ['DSH.Desktop-2.4.0-universal.dmg'], response),
    }), code)
    await expectNoPartialFiles(directory)
  })

  it('rejects a declared body above the fixed 1 GiB limit before writing it', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.5.0',
      destinationPath: destinationPath(directory, 'darwin', '2.5.0'),
      request: releaseServingRequest('2.5.0', ['DSH.Desktop-2.5.0-universal.dmg'], async () => chunkedResponse(
        [dmgArtifact()],
        { 'content-length': String(MAX_UPDATE_DOWNLOAD_BYTES + 1) },
      )),
    }), 'response-too-large')
    await expectNoPartialFiles(directory)
  })

  it('passes the caller signal and removes a partial file when aborted during streaming', async () => {
    const directory = await temporaryDirectory()
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const request: UpdateArtifactRequest = async (url, init) => {
      if (url === desktopReleaseTagEndpoint('2.6.0')) return releaseResponse('2.6.0', ['DSH.Desktop-2.6.0-universal.dmg'])
      requestSignal = init.signal
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          stream.enqueue(dmgArtifact().subarray(0, 128))
          controller.abort(new DOMException('stop', 'AbortError'))
        },
      }))
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.6.0',
      destinationPath: destinationPath(directory, 'darwin', '2.6.0'),
      request,
      signal: controller.signal,
    }), 'aborted')
    expect(requestSignal).toBe(controller.signal)
    await expectNoPartialFiles(directory)
  })

  it('normalizes request aborts and transport failures without creating an artifact', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.0',
      destinationPath: destinationPath(directory, 'darwin', '2.7.0'),
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    }), 'aborted')
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.1',
      destinationPath: destinationPath(directory, 'darwin', '2.7.1'),
      request: async () => { throw new Error('offline') },
    }), 'network')
    await expectNoPartialFiles(directory)
  })

  it.each([
    ['linux', '2.8.0'],
    ['darwin', '../2.8.0'],
    ['win32', 'v2.8.0'],
    ['win32', '2.8.0-rc.1'],
  ])('rejects platform %s and version %s before requesting', async (platform, version) => {
    const directory = await temporaryDirectory()
    let requested = false
    await expectFailure(downloadDesktopUpdate({
      platform: platform as DesktopDownloadPlatform,
      version,
      destinationPath: join(directory, 'installer.dmg'),
      request: async () => {
        requested = true
        return chunkedResponse([dmgArtifact()])
      },
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a relative destination path before requesting', async () => {
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      destinationPath: 'relative.dmg',
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a linked destination directory before requesting', async () => {
    const directory = await temporaryDirectory()
    const linked = `${directory}-link`
    temporaryRoots.push(linked)
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      destinationPath: join(linked, 'installer.dmg'),
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})

describe('desktop update artifact cleanup', () => {
  it('rejects malformed cleanup state with a typed failure', async () => {
    const userDataPath = await temporaryDirectory()
    const updates = join(userDataPath, 'updates')
    await mkdir(updates)
    await writeFile(join(updates, 'pending-installer.json'), '{}')

    await expectFailure(
      pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'win32'),
      'invalid-options',
    )
  })

  it('offers a recorded artifact only after the installed version reaches the update', async () => {
    const userDataPath = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const path = destinationPath(downloads, 'win32', '2.1.0')
    await writeFile(path, windowsArtifact())

    await recordDesktopUpdateArtifact(userDataPath, {
      platform: 'win32',
      version: '2.1.0',
      path,
    })

    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.0.1', 'win32')).resolves.toBeUndefined()
    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'win32')).resolves.toEqual({
      platform: 'win32',
      version: '2.1.0',
      path,
    })
  })

  it.each([false, true])('resolves one cleanup choice with remove=%s', async (remove) => {
    const userDataPath = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const artifact = {
      platform: 'darwin' as const,
      version: '2.1.0',
      path: destinationPath(downloads, 'darwin', '2.1.0'),
    }
    await writeFile(artifact.path, dmgArtifact())
    await recordDesktopUpdateArtifact(userDataPath, artifact)

    await resolveDesktopUpdateArtifact(userDataPath, artifact, remove)

    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'darwin')).resolves.toBeUndefined()
    if (remove) await expect(access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    else await expect(access(artifact.path)).resolves.toBeUndefined()
  })
})

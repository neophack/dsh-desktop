/** Headless version checks against the public DSH Desktop GitHub releases. */

/** GitHub repository that publishes the DSH Desktop update channel. */
export const DESKTOP_RELEASE_REPOSITORY = 'neophack/dsh-desktop'

/** GitHub API endpoint returning the latest published stable release document. */
export const DESKTOP_LATEST_RELEASE_ENDPOINT = `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`

/** GitHub API endpoint listing recent releases, newest first, for Beta discovery. */
export const DESKTOP_RELEASES_LIST_ENDPOINT = `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases?per_page=30`

/** Maximum response body bytes accepted from one GitHub release document. */
export const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024

/** Release streams supported by the Desktop release repository. */
export type DesktopReleaseChannel = 'stable' | 'beta'

/** Strictly parsed SemVer components. Numeric components remain strings to avoid overflow. */
export interface ParsedSemVer {
  /** Canonical version without the optional leading `v`. */
  readonly version: string
  /** Major numeric identifier. */
  readonly major: string
  /** Minor numeric identifier. */
  readonly minor: string
  /** Patch numeric identifier. */
  readonly patch: string
  /** Ordered prerelease identifiers, or an empty list for a stable version. */
  readonly prerelease: readonly string[]
  /** Build identifiers, ignored for version precedence. */
  readonly build: readonly string[]
}

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one channel-scoped version check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as canonical SemVer. */
  readonly currentVersion: string
  /** Release stream that must be discovered in the release repository. */
  readonly channel: DesktopReleaseChannel
  /** Channel of the installed application when explicitly switching streams. */
  readonly currentChannel?: DesktopReleaseChannel
  /** Treat a different older version as selectable for an explicit channel switch. */
  readonly allowDowngrade?: boolean
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
}

/** Successful comparison returned by the release check. */
export type UpdateCheckResult = {
  /** Whether the repository reports a version newer than the installed application. */
  readonly status: 'up-to-date' | 'update-available'
  /** Canonical installed version, including any prerelease identifiers. */
  readonly currentVersion: string
  /** Canonical latest version discovered for the requested channel. */
  readonly latestVersion: string
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Parse strict SemVer with an optional lowercase `v` prefix.
 * @param input - complete version or release tag.
 * @returns parsed identifiers, or null when the input is not valid SemVer.
 */
export function parseSemVer(input: string): ParsedSemVer | null {
  const version = input.startsWith('v') ? input.slice(1) : input
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return null

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return null

  return {
    version,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Compare two strict SemVer strings without numeric overflow.
 * @param left - first strict SemVer value.
 * @param right - second strict SemVer value.
 * @returns negative, zero, or positive precedence, or null when either value is invalid.
 */
export function compareSemVerVersions(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left)
  const rightVersion = parseSemVer(right)
  if (leftVersion === null || rightVersion === null) return null
  return compareParsedSemVer(leftVersion, rightVersion)
}

/**
 * Check the DSH Desktop GitHub releases for one channel.
 * @param options - installed version, caller-owned signal, and optional request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForDesktopUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const current = parseCanonicalChannelVersion(
    options.currentVersion,
    options.currentChannel ?? options.channel,
  )
  if (current === null) return null

  const endpoint = options.channel === 'beta'
    ? DESKTOP_RELEASES_LIST_ENDPOINT
    : DESKTOP_LATEST_RELEASE_ENDPOINT
  const init: RequestInit = {
    method: 'GET',
    headers: desktopReleaseRequestHeaders(),
    cache: 'no-store',
    redirect: 'follow',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const request = options.request ?? defaultRequest

  let response: Response
  try {
    response = await request(endpoint, init)
  } catch {
    return null
  }
  if (response.status !== 200) return null

  let body: string
  try {
    body = await readBoundedResponseText(response, MAX_RELEASE_RESPONSE_BYTES)
  } catch {
    return null
  }

  const latest = options.channel === 'beta'
    ? latestBetaReleaseVersion(body)
    : latestStableReleaseVersion(body)
  if (latest === null) return null
  const comparison = compareParsedSemVer(latest, current)
  return {
    status: comparison > 0 || (options.allowDowngrade === true && comparison !== 0)
      ? 'update-available'
      : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
  }
}

/** Backward-compatible stable-channel entry point for existing callers. */
export function checkForStableUpdate(
  options: Omit<UpdateCheckOptions, 'channel'>,
): Promise<UpdateCheckResult | null> {
  return checkForDesktopUpdate({ ...options, channel: 'stable' })
}

/** Header set identifying the GitHub release API client; no Desktop identifiers are attached. */
export function desktopReleaseRequestHeaders(): Readonly<Record<string, string>> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'DSH-Desktop-Update-Check',
  }
}

/**
 * Build the GitHub API endpoint returning one release document by its `v`-prefixed tag.
 * @param version - canonical release version whose document is requested.
 * @returns the fixed tag endpoint URL.
 */
export function desktopReleaseTagEndpoint(version: string): string {
  return `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/tags/v${version}`
}

/**
 * Read one response body completely while enforcing a byte bound on declared and streamed length.
 * @param response - response whose body is read as UTF-8 text.
 * @param maxBytes - maximum accepted body size in bytes.
 * @returns the decoded body text.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    throw new Error('response body is too large')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('response body is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

function latestStableReleaseVersion(body: string): ParsedSemVer | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.tag_name !== 'string') return null
  return parseReleaseTag(value.tag_name, 'stable')
}

function latestBetaReleaseVersion(body: string): ParsedSemVer | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!Array.isArray(value)) return null
  let latest: ParsedSemVer | null = null
  for (const entry of value) {
    if (!isRecord(entry) || entry.draft === true || typeof entry.tag_name !== 'string') continue
    const parsed = parseReleaseTag(entry.tag_name, 'beta')
    if (parsed === null) continue
    if (latest === null || compareParsedSemVer(parsed, latest) > 0) latest = parsed
  }
  return latest
}

function parseReleaseTag(tag: string, channel: DesktopReleaseChannel): ParsedSemVer | null {
  return parseCanonicalChannelVersion(tag.startsWith('v') ? tag.slice(1) : tag, channel)
}

function parseCanonicalChannelVersion(
  input: string,
  channel: DesktopReleaseChannel,
): ParsedSemVer | null {
  const parsed = parseCanonicalVersion(input)
  if (parsed === null) return null
  if (channel === 'stable') return parsed.prerelease.length === 0 ? parsed : null
  return parsed.prerelease.length === 2
    && parsed.prerelease[0] === 'beta'
    && isNumeric(parsed.prerelease[1]!)
    ? parsed
    : null
}

function parseCanonicalVersion(input: string): ParsedSemVer | null {
  const parsed = parseSemVer(input)
  return parsed !== null && parsed.version === input ? parsed : null
}

function compareParsedSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumeric(leftIdentifier)
    const rightNumeric = isNumeric(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

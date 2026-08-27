/**
 * Wire types for the NewAPI (new-api) admin console API.
 *
 * NewAPI is an OpenAI-compatible gateway; its management endpoints live under
 * `/api` on the console origin. This module only describes shapes we consume.
 * All fields are optional on the wire — gateways drift — so every consumer
 * treats missing data as "unknown", never as zero.
 */

/** Session/user info returned by `GET /api/user/self`. */
export interface NewApiUser {
  id: number
  username?: string
  display_name?: string
  email?: string
  role?: number
  status?: number
  /** Remaining quota in NewAPI's internal unit (see {@link QUOTA_PER_UNIT}). */
  quota?: number
  /** Historical used quota, same unit. */
  used_quota?: number
  /** Total request count. */
  request_count?: number
  /** Access group, e.g. "default", "vip". */
  group?: string
  /** Raw extras preserved for forward compatibility. */
  [key: string]: unknown
}

/** One API key (token) row from `GET /api/token/`. */
export interface NewApiToken {
  id: number
  name?: string
  key?: string
  status?: number
  /** Quota remaining for this token; NewAPI uses -1 to mean "unlimited, draw from user quota". */
  quota?: number
  used_quota?: number
  /** Unix milliseconds. */
  created_time?: number
  accessed_time?: number
  expired_time?: number
  /** Comma-separated model list, or -1 meaning "all models the user group can access". */
  models?: string
  /** Subnet restriction, empty or 0 = none. */
  subnet?: string
  /** Access group for this token. */
  group?: string
  [key: string]: unknown
}

/** Model metadata from `GET /api/user/models` (ids) enriched with `/api/pricing`. */
export interface NewApiModel {
  /** Model id as accepted by the OpenAI-compatible endpoint. */
  id: string
  /** Whether pricing metadata was found for this model. */
  priced?: boolean
  /** Owned-units per 1M prompt tokens. */
  inputPrice?: number
  /** Owned-units per 1M completion tokens. */
  outputPrice?: number
  [key: string]: unknown
}

/** Dashboard/usage summary (best effort across NewAPI versions). */
export interface NewApiUsage {
  /** Human-facing quota numbers from /api/user/self, normalized to currency-ish units. */
  quotaUsed?: number
  quotaRemaining?: number
  quotaTotal?: number
  /** True when the account reports unlimited quota. */
  unlimited?: boolean
  /** Recent token consumption stats keyed by model id, if available. */
  byModel?: Array<{ model: string; tokens?: number; count?: number }>
}

/** Normalized snapshot the client UI renders. */
export interface NewApiSnapshot {
  user: NewApiUser | undefined
  tokens: NewApiToken[]
  models: NewApiModel[]
  usage: NewApiUsage
}

/** NewAPI stores quota in units of 1/QUOTA_PER_UNIT of one US dollar by default. */
export const QUOTA_PER_UNIT = 500_000

/** Convert NewAPI internal quota to display units (USD). Returns undefined for unknown input. */
export function quotaToUsd(quota: number | undefined): number | undefined {
  if (quota === undefined || !Number.isFinite(quota)) return undefined
  return quota / QUOTA_PER_UNIT
}

/**
 * Convert display units back to internal quota, rounded to integer.
 * Negative values pass through (NewAPI uses quota < 0 for "unlimited token").
 */
export function usdToQuota(usd: number): number {
  return Math.round(usd * QUOTA_PER_UNIT)
}

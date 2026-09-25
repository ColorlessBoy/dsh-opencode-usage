/**
 * dsh-opencode-usage — host half.
 *
 * Serves one same-origin JSON endpoint that the browser half polls:
 *
 *   GET /api/opencode-usage?provider=<route key>
 *
 * The request names the provider route the client currently has selected. The
 * route resolves that provider's `baseURL` from the live `llm-pi-ai` settings
 * entry and acts only when it is an OpenCode Zen "Go" endpoint, where the
 * official quota API lives:
 *
 *   GET <baseURL>/usage     Authorization: Bearer <credential from apiKeyEnv>
 *
 * The API key is read through the harness credential seam and never leaves
 * this process. Answers are cached per route so a polling browser cannot
 * hammer the upstream service.
 *
 * Answers:
 *   { applicable: false }                          provider is not a Zen Go route
 *   { applicable: true, usage, fetchedAt }         quota read succeeded
 *   { applicable: true, error }                    quota read failed
 *
 * `error` is a short code: `no-credential`, `http-<status>`, `malformed`, or
 * `network`. A route absent from the `llm-pi-ai` section (another adapter
 * family owns it) is not applicable: nothing states its endpoint, so it cannot
 * be an OpenCode Go route, and the browser half stays hidden rather than
 * raising a false alarm.
 */

export const name = 'opencode-usage'

/**
 * The web server is the only required service. Settings, credentials, and the
 * browser-connection auth check are consumed through `ctx.get` so a host-only
 * composition without them still loads.
 */
export const inject = ['webServer']

/** Browser-facing path of the usage API (an exact route, so it wins over the `/api` prefix). */
const ROUTE_PATH = '/api/opencode-usage'
/** Cache lifetime of a successful read: the upstream quota moves slowly. */
const SUCCESS_TTL_MS = 30_000
/** Shorter cache lifetime for a failure, so a transient error clears quickly. */
const FAILURE_TTL_MS = 10_000
/** Upstream request timeout. */
const REQUEST_TIMEOUT_MS = 10_000
/** The three quota windows the endpoint reports, in display order. */
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

/** Successful and failed answers, keyed by provider route, with their cache stamp. */
const cache = new Map()
/** In-flight reads keyed by provider route: concurrent polls share one upstream call. */
const inflight = new Map()

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** The only host whose `/zen/go` path is the OpenCode Go quota service. */
const ZEN_HOST = 'opencode.ai'

/**
 * Derive the OpenCode Zen Go quota endpoint from one provider `baseURL`, or
 * `undefined` when that URL is not a Zen Go route. Detection is by URL, so a
 * provider key that merely looks like `opencode-go` is not enough: a route
 * pointing anywhere else answers "not applicable". Both a route-level URL
 * (`https://opencode.ai/zen/go/v1`) and its root (`https://opencode.ai/zen/go`)
 * map to the same `/v1/usage` endpoint. The host must be `opencode.ai` (or a
 * subdomain of it), because this route sends the credential stored for the
 * provider and must not be aimed at an unrelated host that merely shares the
 * path.
 * @param baseURL - the provider's configured endpoint.
 * @returns the quota endpoint URL, or undefined.
 */
function zenGoUsageUrl(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) return undefined
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  if (parsed.hostname !== ZEN_HOST && !parsed.hostname.endsWith(`.${ZEN_HOST}`)) return undefined
  const path = parsed.pathname.replace(/\/+$/u, '')
  if (path !== '/zen/go' && !path.startsWith('/zen/go/')) return undefined
  const versioned = path.endsWith('/v1') ? path : `${path}/v1`
  return `${parsed.origin}${versioned}/usage`
}

/**
 * Reduce the upstream payload to the three display windows, dropping fields a
 * window does not carry. The upstream `percent` is the USED share; only its
 * complement is published, so every quantity this plugin carries — wire,
 * chip, panel, accessible name — is a remaining share.
 * @param payload - the parsed upstream JSON.
 * @returns the normalized windows, or undefined when none is usable.
 */
function normalize(payload) {
  const usage = payload !== null && typeof payload === 'object' ? payload.usage : undefined
  if (usage === null || typeof usage !== 'object') return undefined
  const windows = {}
  for (const key of WINDOW_KEYS) {
    const window = usage[key]
    if (window === null || typeof window !== 'object') continue
    const used = typeof window.percent === 'number' && Number.isFinite(window.percent)
      ? window.percent
      : undefined
    windows[key] = {
      ...(typeof window.status === 'string' ? { status: window.status } : {}),
      ...(used === undefined ? {} : { remainingPercent: Math.max(0, 100 - used) }),
      ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
    }
  }
  return Object.keys(windows).length > 0 ? windows : undefined
}

/**
 * Resolve the provider's profile from the `llm-pi-ai` settings entry.
 *
 * The settings service projects every active profile entry's resolved live
 * value, so this entry's `providers` map is the same resolved map the adapter
 * serves requests from. A composition without that service or entry cannot
 * name an endpoint, so the route stays "not applicable" rather than raising a
 * false alarm.
 * @param ctx - the plugin context.
 * @param provider - the route key to resolve.
 * @returns the profile object, or undefined when this route is not declared there.
 */
function providerProfile(ctx, provider) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.describe !== 'function') return undefined
  let descriptors
  try {
    descriptors = settings.describe()
  } catch {
    return undefined
  }
  if (!Array.isArray(descriptors)) return undefined
  const entry = descriptors.find((row) => row.ns === 'llm-pi-ai')
  const providers = entry?.value?.providers
  if (providers === null || typeof providers !== 'object') return undefined
  const profile = providers[provider]
  return profile !== null && typeof profile === 'object' ? profile : undefined
}

/**
 * Read one provider's live quota from the upstream endpoint.
 * @param ctx - the plugin context.
 * @param provider - the provider route key.
 * @returns the browser-facing body (never throws).
 */
async function readUsage(ctx, provider) {
  const profile = providerProfile(ctx, provider)
  if (profile === undefined) return { applicable: false }
  const usageUrl = zenGoUsageUrl(profile.baseURL)
  if (usageUrl === undefined) return { applicable: false }
  const apiKeyEnv = profile.apiKeyEnv
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) {
    return { applicable: true, error: 'no-credential' }
  }
  let credential
  try {
    credential = await ctx.get('credentials')?.resolve(apiKeyEnv)
  } catch {
    return { applicable: true, error: 'no-credential' }
  }
  const apiKey = credential?.value
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { applicable: true, error: 'no-credential' }
  }
  try {
    const response = await fetch(usageUrl, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return { applicable: true, error: `http-${String(response.status)}` }
    const usage = normalize(await response.json())
    if (usage === undefined) return { applicable: true, error: 'malformed' }
    return { applicable: true, usage, fetchedAt: Date.now() }
  } catch {
    return { applicable: true, error: 'network' }
  }
}

/**
 * Serve one provider's cached quota body, reading upstream on a miss.
 * @param ctx - the plugin context.
 * @param provider - the provider route key.
 * @returns the browser-facing body.
 */
async function usageBody(ctx, provider) {
  const cached = cache.get(provider)
  if (cached !== undefined && Date.now() - cached.at < cached.ttl) return cached.body
  const pending = inflight.get(provider)
  if (pending !== undefined) return pending
  const task = readUsage(ctx, provider)
    .then((body) => {
      cache.set(provider, {
        at: Date.now(),
        ttl: body.error === undefined ? SUCCESS_TTL_MS : FAILURE_TTL_MS,
        body,
      })
      return body
    })
    .finally(() => { inflight.delete(provider) })
  inflight.set(provider, task)
  return task
}

/**
 * Handle one GET: authenticate, resolve the provider, answer with its quota.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @param res - the response to own.
 */
async function handle(ctx, req, res) {
  const rejection = ctx.get('connection')?.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method-not-allowed' })
    return
  }
  const provider = new URL(req.url ?? '/', 'http://localhost').searchParams.get('provider') ?? ''
  if (provider.length === 0) {
    json(res, 400, { error: 'missing-provider' })
    return
  }
  json(res, 200, await usageBody(ctx, provider))
}

/**
 * Register the usage route on the host web server.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => handle(ctx, req, res),
    }),
    'opencode-usage: /api/opencode-usage route',
  )
}

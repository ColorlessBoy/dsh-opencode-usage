/**
 * Host-half behaviour check: route registration, URL-based provider detection,
 * credential resolution, normalization, error codes, caching, and auth.
 */
import assert from 'node:assert/strict'

const ZEN = { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY_3' }
const PROVIDERS = {
  'opencode-go-3': ZEN,
  'opencode-go-root': { baseURL: 'https://opencode.ai/zen/go/', apiKeyEnv: 'OPENCODE_GO_API_KEY_3' },
  'opencode-go-nokey': { baseURL: 'https://opencode.ai/zen/go/v1' },
  'opencode-go-http': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY_3' },
  'opencode-go-malformed': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY_3' },
  'opencode-go-network': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY_3' },
  'deepseek-official': { baseURL: 'https://api.deepseek.com' },
  'evil-opencode-go': { baseURL: 'https://evil.example/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY_3' },
}

let route
let rejection
const effects = []
const ctx = {
  effect: (fn, label) => { effects.push(label); fn() },
  webServer: { register: (r) => { route = r; return () => {} } },
  get: (name) => {
    if (name === 'settings') return { get: (ns) => (ns === 'llm-pi-ai' ? { providers: PROVIDERS } : undefined) }
    if (name === 'credentials') return { resolve: async (ref) => (ref === 'OPENCODE_GO_API_KEY_3' ? { value: 'sk-test' } : undefined) }
    if (name === 'connection') return { requestRejection: () => rejection }
    return undefined
  },
}

const { name, inject, apply } = await import('../lib/index.js')
assert.equal(name, 'opencode-usage')
assert.deepEqual(inject, ['webServer'])
apply(ctx)
assert.equal(effects.length, 1)
assert.equal(route.kind, 'exact')
assert.equal(route.path, '/api/opencode-usage')

const upstream = []
const payload = {
  usage: {
    rolling: { status: 'ok', percent: 6, resetsAt: '2026-09-22T04:13:30.335Z' },
    weekly: { status: 'ok', percent: 11.5, resetsAt: '2026-09-28T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 55, resetsAt: '2026-10-19T13:02:27.000Z' },
  },
}
const answer = (payload, status = 200) => async (url, init) => {
  upstream.push({ url, init })
  return { ok: status === 200, status, json: async () => payload }
}
globalThis.fetch = answer(payload)

async function request(method, url) {
  const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
  await route.handler({ method, url, headers: {} }, res)
  let body
  try {
    body = res.body === '' ? undefined : JSON.parse(res.body)
  } catch {
    body = res.body
  }
  return { status: res.status, body }
}
// 1. A Zen Go route answers normalized windows and sends the Bearer credential.
const ok = await request('GET', '/api/opencode-usage?provider=opencode-go-3')
assert.equal(ok.status, 200)
assert.equal(ok.body.applicable, true)
assert.deepEqual(Object.keys(ok.body.usage), ['rolling', 'weekly', 'monthly'])
// No used share crosses the wire: the normalized window carries remaining only.
assert.deepEqual(Object.keys(ok.body.usage.rolling).sort(), ['remainingPercent', 'resetsAt', 'status'])
assert.equal(ok.body.usage.rolling.remainingPercent, 94)
assert.equal(ok.body.usage.weekly.remainingPercent, 88.5)
assert.equal(ok.body.usage.monthly.remainingPercent, 45)
assert.equal(ok.body.usage.rolling.resetsAt, '2026-09-22T04:13:30.335Z')
assert.equal(upstream.length, 1)
assert.equal(upstream[0].url, 'https://opencode.ai/zen/go/v1/usage')
assert.equal(upstream[0].init.headers.authorization, 'Bearer sk-test')
assert.ok(typeof ok.body.fetchedAt === 'number')

// 2. The same route is served from cache.
await request('GET', '/api/opencode-usage?provider=opencode-go-3')
assert.equal(upstream.length, 1)

// 3. A baseURL without /v1 still maps to /v1/usage.
const rootForm = await request('GET', '/api/opencode-usage?provider=opencode-go-root')
assert.equal(rootForm.body.applicable, true)
assert.equal(upstream.at(-1).url, 'https://opencode.ai/zen/go/v1/usage')

// 4. Provider detection is by URL, not by key name.
assert.deepEqual((await request('GET', '/api/opencode-usage?provider=deepseek-official')).body, { applicable: false })
assert.deepEqual((await request('GET', '/api/opencode-usage?provider=evil-opencode-go')).body, { applicable: false })

// 5. Missing credential and unknown route.
assert.deepEqual(
  (await request('GET', '/api/opencode-usage?provider=opencode-go-nokey')).body,
  { applicable: true, error: 'no-credential' },
)
assert.deepEqual(
  (await request('GET', '/api/opencode-usage?provider=nope')).body,
  { applicable: false },
)

// 6. Request validation.
assert.equal((await request('GET', '/api/opencode-usage')).status, 400)
assert.equal((await request('POST', '/api/opencode-usage?provider=opencode-go-3')).status, 405)

// 7. Upstream failures surface as codes.
globalThis.fetch = answer({}, 429)
assert.deepEqual(
  (await request('GET', '/api/opencode-usage?provider=opencode-go-http')).body,
  { applicable: true, error: 'http-429' },
)
globalThis.fetch = answer({ nope: true })
assert.deepEqual(
  (await request('GET', '/api/opencode-usage?provider=opencode-go-malformed')).body,
  { applicable: true, error: 'malformed' },
)
globalThis.fetch = async () => { throw new Error('boom') }
assert.deepEqual(
  (await request('GET', '/api/opencode-usage?provider=opencode-go-network')).body,
  { applicable: true, error: 'network' },
)

// 8. A rejected browser request is refused before any route work.
rejection = 401
assert.deepEqual(await request('GET', '/api/opencode-usage?provider=opencode-go-3'), { status: 401, body: 'unauthorized' })
rejection = 403
assert.equal((await request('GET', '/api/opencode-usage?provider=opencode-go-3')).status, 403)

console.log('host.test.mjs: all assertions passed')

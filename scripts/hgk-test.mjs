/** HGK controlled mode の非通信試験。外部への fetch は到達前に失敗させる。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stubUpstream, chatFrames, fakeContext, callRoute, until, freePort } from './lib/fake-kernel.mjs'

const nativeFetch = globalThis.fetch
let externalAttempts = 0
globalThis.fetch = (url, init) => {
  if (!['127.0.0.1', '[::1]'].includes(new URL(String(url)).hostname)) {
    externalAttempts++
    throw new Error('external request blocked by fixture')
  }
  return nativeFetch(url, init)
}
fs.mkdirSync(path.resolve('.verify'), { recursive: true })
const scratch = fs.mkdtempSync(path.resolve('.verify/hgk-test-'))
process.env.DSH_HOME = scratch
let mode = 'ok'
const stub = await stubUpstream({ listing: ['mimo-v2.6-flash-free'], answer: () => {
  if (mode === 'redirect') return { status: 302, body: '' }
  if (mode === 'error') return { status: 500, body: JSON.stringify({ error: { message: 'synthetic-provider-key synthetic-forward-key' } }) }
  if (mode === 'echo') return { body: chatFrames('synthetic-provider-key synthetic-forward-key') }
  if (mode === 'split') return { body: [...'synthetic-provider-key synthetic-forward-key'].map(content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`).join('') + chatFrames('') }
  if (mode === 'cut') return { body: 'data: {"choices":[{"delta":{"reasoning_content":"partial"}}]}\n\n' }
  return { body: chatFrames('fixture answer') }
} })
process.env.OUR_FREE_MODEL_BASE = stub.base
process.env.OUR_FREE_MODEL_KILO_BASE = stub.base
const { createHgkPlane, resolveHgkRoute } = await import('../src/hgk.js')
const { startForwardServer, startLanRelay } = await import('../src/forward.js')
const { buildCatalog, buildKiloCatalog } = await import('../src/catalog.js')
const { buildAggregateCatalog } = await import('../src/aggregate.js')
const free = buildCatalog(['mimo-v2.6-flash-free'])
const settings = { enabled: true, forwardKey: 'synthetic-forward-key', streamRecovery: true, aggregate: { providers: { groq: {
  enabled: true, apiKey: 'synthetic-provider-key', baseUrl: stub.base, models: ['fixture'],
} } } }
const catalog = [...free, ...buildKiloCatalog([{ id: 'kilo-auto/free', isFree: true }, { id: 'openrouter/free', isFree: true }]),
  ...buildAggregateCatalog(settings.aggregate), { id: 'combo:fixture', channel: 'combo', combo: [free[0].id] }]
let available = { results: {} }
const hgk = createHgkPlane({ state: () => ({ catalog, settings }), availability: () => available })
let cfg = { enabled: true, host: '127.0.0.1', port: 0, key: 'synthetic-forward-key', hgkControlled: true }
const logs = []
const server = await startForwardServer({ config: () => cfg, hgk, complete: () => { throw new Error('ordinary completion reached') }, modelRows: () => [], log: message => logs.push(message) })
const base = `http://127.0.0.1:${server.port}`
const headers = { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' }
const post = (body, extra = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
const body = (model = free[0].id, stream = false) => ({ model, messages: [{ role: 'user', content: 'public synthetic request' }], stream })
let checks = 0
const check = async (name, fn) => { await fn(); checks++; console.log(`ok ${name}`) }
try {
  await check('認証と読取専用の観測、未知保持、資格laneの識別', async () => {
    assert.equal((await fetch(`${base}/v1/hgk/routes`)).status, 401)
    const data = (await (await fetch(`${base}/v1/hgk/routes`, { headers })).json()).data
    assert.equal(data.length, 2)
    assert.equal(data[0].availability, 'unknown')
    for (const key of ['dataUse', 'training', 'retention', 'charge', 'quota', 'probedAt']) assert.equal(data[0][key], null)
    assert.equal(data.find(row => row.provider === 'groq').lane, 'credential')
    assert.equal(JSON.stringify(data).includes(settings.aggregate.providers.groq.apiKey), false)
    assert.equal((await fetch(`${base}/v1/hgk/routes`, { method: 'POST', headers })).status, 404)
    assert.equal(stub.requests.length, 0)
  })
  await check('固定routeから既存forward/adapter/transport/readerを通す', async () => {
    const res = await post(body())
    assert.equal(res.status, 200)
    const metadata = JSON.parse(Buffer.from(res.headers.get('x-hgk-resolved'), 'base64url'))
    assert.equal(metadata.destination, `${stub.base}/inference/v1/chat/completions`)
    assert.equal(metadata.provider, 'opencode')
    assert.equal(metadata.outputTrust, 'untrusted')
    assert.deepEqual(metadata.policy, { retries: 0, redirects: false, fallback: false, roundRobin: false, recovery: false })
    assert.equal((await res.json()).choices[0].message.content, 'fixture answer')
    assert.equal(stub.requests.at(-1).body.model, free[0].id)
  })
  await check('combo・auto・unknown・別名を送信前に拒否', async () => {
    const before = stub.requests.length
    for (const id of ['combo:fixture', 'kilo-auto/free', 'openrouter/free', 'missing', `${free[0].id}(high)`]) assert.ok((await post(body(id))).status >= 400)
    assert.equal(stub.requests.length, before)
  })
  await check('既存観測の変化とstaleを反映し、全拒否でも迂回しない', async () => {
    available = { results: { [free[0].id]: { state: 'unavailable', at: 1234 } } }
    const before = stub.requests.length
    assert.equal((await post(body())).status, 503)
    const row = (await (await fetch(`${base}/v1/hgk/routes`, { headers })).json()).data[0]
    assert.equal(row.availability, 'unavailable'); assert.equal(row.probedAt, 1234)
    assert.equal(stub.requests.length, before)
    available.results[free[0].id].stale = true
    assert.equal(hgk.observe().data[0].availability, 'unknown')
    available = { results: { [free[0].id]: { state: 'available', at: 2345 } } }
    assert.equal((await post(body())).status, 200)
  })
  await check('失敗・断流・redirectを再送せず秘密を応答やログに残さない', async () => {
    for (const failure of ['error', 'cut', 'redirect']) {
      mode = failure
      const before = stub.requests.length
      const response = await post(body())
      assert.equal(response.status, 502)
      const text = await response.text()
      assert.equal(text.includes('synthetic-provider-key'), false)
      assert.equal(text.includes('synthetic-forward-key'), false)
      assert.equal(response.headers.get('x-should-retry'), 'false')
      assert.equal(stub.requests.length, before + 1)
    }
    for (const stream of [false, true]) {
      mode = stream ? 'split' : 'echo'
      const response = await post(body('groq/fixture', stream))
      const text = await response.text()
      assert.equal(response.status, 200)
      assert.equal(text.includes('synthetic-provider-key'), false)
      assert.equal(text.includes('synthetic-forward-key'), false)
      assert.ok(text.includes('[redacted]'))
      if (stream) {
        const joined = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '').join('')
        assert.equal(joined.includes('synthetic-'), false)
      }
    }
    assert.equal(logs.join().includes('synthetic-'), false)
    mode = 'ok'
  })
  await check('streamと資格providerも明示した宛先だけを使う', async () => {
    const response = await post(body('groq/fixture', true))
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes('fixture answer'))
    assert.equal(stub.requests.at(-1).path, '/chat/completions')
    assert.equal(stub.requests.at(-1).body.model, 'fixture')
  })
  await check('LAN relayのhop・外向きbind・LAN設定・設定切替を拒否', async () => {
    assert.equal((await post(body(), { 'x-ofm-relay-hop': '1' })).status, 403)
    const relay = await startLanRelay({ config: () => ({ enabled: true, host: '127.0.0.1', port: 0, lanKey: 'fixture-lan', localKey: cfg.key, targetPort: server.port }) })
    try {
      const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, { method: 'POST', headers: { ...headers, authorization: 'Bearer fixture-lan' }, body: JSON.stringify(body()) })
      assert.equal(res.status, 403)
    } finally { await relay.close() }
    await assert.rejects(startForwardServer({ config: () => ({ ...cfg, host: '0.0.0.0' }), hgk }), /loopback/)
    await assert.rejects(startForwardServer({ config: () => ({ ...cfg, lan: { enabled: true } }), hgk }), /HGK_CONFIGURATION_REJECTED/)
    cfg = { ...cfg, hgkControlled: false }
    assert.equal((await post(body())).status, 403)
    cfg.hgkControlled = true
    settings.egress = { enabled: true }
    assert.equal((await post(body())).status, 503)
    settings.egress.enabled = false
    const bad = structuredClone(settings)
    bad.aggregate.providers.groq.baseUrl = `${stub.base}/?key=synthetic-provider-key`
    assert.throws(() => resolveHgkRoute(catalog.find(row => row.providerId === 'groq'), bad))
  })
  await check('プラグイン入口の設定からHGK forwardへ到達する', async () => {
    const port = await freePort()
    const dir = path.join(scratch, 'our-free-model')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ distribution: 'managed', enabled: true,
      forward: { enabled: true, host: '127.0.0.1', port, hgkControlled: true }, forwardKey: cfg.key }))
    const { apply, inject } = await import('../index.js')
    const routes = []
    const ctx = fakeContext({ inject, onRegister: route => routes.push(route) })
    apply(ctx, { distribution: 'managed' })
    try {
      await until(async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/v1/hgk/routes`, { headers })).status === 200 } catch { return false }
      }, { timeoutMs: 5000 })
      const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body()) })
      assert.equal(result.status, 200)
      await result.text()
      await until(() => routes.some(row => row.kind === 'prefix'), { timeoutMs: 5000 })
      const api = routes.find(row => row.kind === 'prefix').handler
      const rejected = await callRoute(api, 'POST', '/api/our-free-model/settings', { forward: { lan: { enabled: true } } })
      assert.equal(rejected.status, 400)
    } finally { for (const dispose of ctx.__disposers.reverse()) dispose() }
  })
} finally {
  await server.close()
  await stub.close()
  globalThis.fetch = nativeFetch
}
assert.equal(externalAttempts, 0)
console.log(`${checks} HGK checks passed; external provider requests: 0`)

/** HGK 下流の供給層。権限・P0 判定・親受入は扱わない。 */
import { FreeModelAdapter, ROUTE_MAIN } from './adapter.js'
import { createForwardCompletion } from './core/completion.js'
import { isKiloEntry } from './catalog.js'
import { isAggregateEntry, resolveProvider } from './aggregate.js'
import { endpointFor, UPSTREAM_BASE } from './upstream.js'
import { KILO_BASE } from './kilo.js'
import { modelAvailability } from './model-test.js'
import { egressActive } from './egress.js'
import { credentialRedactor } from './subscription-completion.js'

const POLICY = Object.freeze({ retries: 0, redirects: false, fallback: false, roundRobin: false, recovery: false })
const AUTO_ID = /(?:^|[/:._-])(?:auto|automatic|router|round-robin)(?:$|[/:._-])/i
const AUTO_ROUTES = new Set(['openrouter/free'])
const STATES = new Set(['available', 'unavailable', 'region-blocked', 'throttled', 'unknown'])
const SOURCES = new Set(['manual', 'listing', 'probe'])
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

/** URL の資格・検索文字列・断片を観測へ流さず、そのような宛先を使用しない。 */
function destination(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw fail(400, 'HGK_DESTINATION_UNSUPPORTED')
  }
  return url.href
}

/** カタログの実在行を基に解決する。内部の経路を検証できない車道は拒否する。 */
export function resolveHgkRoute(entry, settings) {
  if (!entry || typeof entry.id !== 'string' || entry.id.startsWith('combo:') || AUTO_ROUTES.has(entry.id) || AUTO_ID.test(entry.id)) {
    throw fail(400, 'HGK_EXPLICIT_ROUTE_REQUIRED')
  }
  if (isKiloEntry(entry)) return {
    provider: 'kilo', model: entry.id, route: entry.id,
    destination: destination(`${KILO_BASE}/chat/completions`), lane: 'keyless-free', source: 'kilo-listing-cache',
  }
  if (isAggregateEntry(entry)) {
    if (AUTO_ROUTES.has(entry.modelId) || AUTO_ID.test(entry.modelId)) throw fail(400, 'HGK_EXPLICIT_ROUTE_REQUIRED')
    const resolved = resolveProvider(settings.aggregate, entry.providerId)
    if (resolved.apiKey && resolved.chatUrl.includes(resolved.apiKey)) throw fail(400, 'HGK_DESTINATION_UNSUPPORTED')
    return {
      provider: resolved.providerId, model: entry.modelId, route: entry.id,
      destination: destination(resolved.chatUrl),
      lane: resolved.provider.auth.kind === 'none' ? 'keyless' : 'credential',
      source: resolved.provider.source ?? null,
    }
  }
  if (entry.channel !== undefined) throw fail(400, 'HGK_LANE_UNSUPPORTED')
  return {
    provider: 'opencode', model: entry.id, route: entry.id,
    destination: destination(`${UPSTREAM_BASE}${endpointFor(entry.id)}`), lane: 'keyless-free', source: 'opencode-catalog-cache',
  }
}

function measured(entry, snapshot) {
  const row = modelAvailability(entry.id, snapshot, Boolean(entry.channel))
  return {
    availability: STATES.has(row.availability) ? row.availability : 'unknown',
    availabilitySource: SOURCES.has(row.availabilitySource) ? row.availabilitySource : null,
    probedAt: row.probedAt > 0 ? row.probedAt : null,
  }
}

/** 読取時点の既存観測だけを返す。問い合わせ自体は通信・探測・保存しない。 */
export function createHgkPlane({ state, availability, adapterDependencies = {} }) {
  const rows = () => {
    const snapshot = state()
    return snapshot.catalog.flatMap(entry => {
      try {
        return [{ ...resolveHgkRoute(entry, snapshot.settings), ...measured(entry, availability()),
          dataUse: null, training: null, retention: null, charge: null, quota: null,
          policy: POLICY, outputTrust: 'untrusted',
        }]
      } catch { return [] }
    })
  }
  return {
    observe: () => ({ object: 'list', data: rows() }),
    modelRows: () => rows().map(row => ({ id: row.route, object: 'model', owned_by: row.provider })),
    async complete(request, onChunk) {
      const current = state()
      const snapshot = { ...current, settings: structuredClone(current.settings) }
      const model = request.openAi?.model
      // forward が通常モードで受け入れる思考強度の接尾辞も HGK では別名なので拒否。
      if (typeof model !== 'string' || model !== request.model || model.trim() !== model) throw fail(400, 'HGK_EXPLICIT_ROUTE_REQUIRED')
      const entry = snapshot.catalog.find(row => row.id === model)
      if (!entry) throw fail(404, 'HGK_UNKNOWN_ROUTE')
      let resolved
      try { resolved = resolveHgkRoute(entry, snapshot.settings) } catch { throw fail(400, 'HGK_ROUTE_UNSUPPORTED') }
      // 可変の出口選択を重ねず、指定した gateway 宛てに直接送る。
      if (snapshot.settings.egress?.enabled === true || egressActive()) throw fail(503, 'HGK_EGRESS_UNSUPPORTED')
      const observation = measured(entry, availability())
      if (['unavailable', 'region-blocked', 'throttled'].includes(observation.availability)) throw fail(503, 'HGK_ROUTE_UNAVAILABLE')
      request.onResolved?.({ ...resolved, ...observation,
        dataUse: null, training: null, retention: null, charge: null, quota: null,
        policy: POLICY, outputTrust: 'untrusted',
      })
      const pinned = {
        ...snapshot, catalog: [entry], membership: { [ROUTE_MAIN]: [entry.id] },
        settings: { ...snapshot.settings, streamRecovery: false, tokenSaver: { enabled: false } },
      }
      // 既存の変換・送信・解析を再使用。HGK 呼出しは本文や警告を監査へ保存しない。
      const adapter = new FreeModelAdapter({ ...adapterDependencies, state: () => pinned,
        recordUsage() {}, recordTurn() {}, warn() {},
      })
      const complete = createForwardCompletion({ adapter, state: () => pinned })
      const secrets = [snapshot.settings.forwardKey,
        ...Object.values(snapshot.settings.aggregate?.providers ?? {}).map(row => row?.apiKey),
      ].filter(value => typeof value === 'string' && value !== '')
      const scrub = value => {
        if (typeof value === 'string') {
          for (const secret of secrets) value = value.split(secret).join('[redacted]')
          return value
        }
        if (Array.isArray(value)) return value.map(scrub)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrub(child)]))
        return value
      }
      const safeChunk = chunk => {
        if (chunk.type !== 'finish' || !chunk.reason?.failure) return scrub(chunk)
        return { type: 'finish', reason: { kind: chunk.reason.kind, failure: { code: 'HGK_UPSTREAM_FAILED', message: 'HGK_UPSTREAM_FAILED' } } }
      }
      const emit = typeof onChunk === 'function' ? credentialRedactor(secrets, chunk => onChunk(safeChunk(chunk))) : undefined
      try {
        const outcome = await complete(request, emit)
        if (outcome.error !== undefined) return { text: '', toolCalls: [], error: 'HGK_UPSTREAM_FAILED', failure: { code: 'HGK_UPSTREAM_FAILED', message: 'HGK_UPSTREAM_FAILED' } }
        return scrub(outcome)
      } catch { throw fail(502, 'HGK_UPSTREAM_FAILED') }
    },
  }
}

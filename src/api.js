// Thin client over the Express proxy. The browser never sees the API key
// unless the user explicitly enters one in ⚙️ 模型设置 (then it's sent to our own proxy).
import { withConfig } from './modelConfig.js'
import { parseLenient } from './jsonutil.js'

const BACKEND_DOWN =
  'API 不可用：服务器返回了 HTML 页面而非 JSON。生产环境请确认 Vercel 已部署 /api 后端；本地请运行 npm run dev 并确保 8787 端口可用。'

// If the proxy falls through to the SPA or CDN 404, we get text/html instead of our JSON/stream.
function assertApi(res) {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/html')) throw new Error(BACKEND_DOWN)
}

async function readJSON(res) {
  const text = await res.text()
  const trimmed = text.trimStart()
  if (
    trimmed.startsWith('<!') ||
    trimmed.startsWith('<') ||
    /^The page /i.test(trimmed)
  ) {
    throw new Error(BACKEND_DOWN)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`API 返回非 JSON：${text.slice(0, 120)}`)
  }
}

export async function streamChat({ system, messages, model, provider, effort, max_tokens, onText, signal }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ system, messages, model, provider, effort, max_tokens })),
    signal,
  })
  assertApi(res)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = dec.decode(value, { stream: true })
    full += chunk
    onText?.(full, chunk)
  }
  return full
}

export async function streamPrd({ product, onText, signal }) {
  const res = await fetch('/api/prd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ product })),
    signal,
  })
  assertApi(res)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    full += dec.decode(value, { stream: true })
    onText?.(full)
  }
  return full
}

export async function streamRevise({ doc, review, kind, onText, signal }) {
  const res = await fetch('/api/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ doc, review, kind })),
    signal,
  })
  assertApi(res)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    full += dec.decode(value, { stream: true })
    onText?.(full)
  }
  return full
}

export async function streamProposal({ product, paradigm, paradigmDesc, monetization, roi, onText, signal }) {
  const res = await fetch('/api/proposal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ product, paradigm, paradigmDesc, monetization, roi })),
    signal,
  })
  assertApi(res)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    full += dec.decode(value, { stream: true })
    onText?.(full)
  }
  return full
}

export async function streamDemo({ spec, paradigm, productName, onText, signal }) {
  const res = await fetch('/api/build-demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ spec, paradigm, productName })),
    signal,
  })
  assertApi(res)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    full += dec.decode(value, { stream: true })
    onText?.(full)
  }
  return full
}

export async function genSlides(md) {
  const res = await fetch('/api/slides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ md })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function prdOutline(product) {
  const res = await fetch('/api/prd-outline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ product })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function prdSection({ product, outline, chapter }) {
  const res = await fetch('/api/prd-section', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ product, outline, chapter })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.text
}

export async function complete({ system, messages, model, provider, effort, max_tokens, format }) {
  const res = await fetch('/api/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ system, messages, model, provider, effort, max_tokens, format })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.text
}

// Structured call: returns parsed JSON (tolerant). Pass a json_schema in `format`.
export async function completeJSON({ system, messages, format, model, provider, max_tokens }) {
  const text = await complete({ system, messages, format, model, provider, max_tokens, effort: 'low' })
  return parseLenient(text)
}

async function postJSON(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withConfig(body)) })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
export const getFit = (product) => postJSON('/api/fit', { product })
export const reviewDoc = (doc, kind) => postJSON('/api/review', { doc, kind })
export const genBmc = (product) => postJSON('/api/bmc', { product })
export const genMonetize = (product, paradigm, paradigmDesc) => postJSON('/api/monetize', { product, paradigm, paradigmDesc })
export const genRoi = (product, paradigm, paradigmDesc, monetization) => postJSON('/api/roi', { product, paradigm, paradigmDesc, monetization })

export async function advise(product, goal) {
  const res = await fetch('/api/advise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ product, goal })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function analyzeCompetitor({ name, url, notes }) {
  const res = await fetch('/api/compete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ name, url, notes })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function compareCompetitors(products) {
  const res = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ products })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function answer(query) {
  const res = await fetch('/api/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withConfig({ query })),
  })
  assertApi(res)
  const data = await readJSON(res)
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

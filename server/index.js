import express from 'express'
import { jsonrepair } from 'jsonrepair'
import { streamText, completeText, webSearchSetup } from './providers.js'

// Tolerant parse for model-produced JSON: strip fences/prose, repair bad commas & truncation.
function parseModelJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  // cleanup: collapse double commas, strip commas before closers / after openers
  const cleaned = t
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{[])\s*,/g, '$1')
  for (const candidate of [t, cleaned]) {
    try { return JSON.parse(candidate) } catch {}
    try { return JSON.parse(jsonrepair(candidate)) } catch {}
  }
  throw new Error('unparseable model JSON')
}

const PORT = process.env.PORT || 8787

if (!process.env.ANTHROPIC_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  console.warn(
    '\n[!] 未检测到 ANTHROPIC_API_KEY 或 DEEPSEEK_API_KEY。\n' +
      '    可以 export 其一，或在网页右下角 ⚙️ 模型设置里填入 key。\n'
  )
}

const app = express()
app.use(express.json({ limit: '2mb' }))

// --- Streaming chat: writes raw text deltas to the response body ---
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  try {
    for await (const t of streamText({ ...req.body, max_tokens: req.body.max_tokens || 4096 })) {
      res.write(t)
    }
    res.end()
  } catch (e) {
    res.write(`\n\n⚠️ 请求失败：${e?.message || e}`)
    res.end()
  }
})

// --- Full PRD generation: expert prompt + product info → streamed Markdown ---
const PRD_SYS = `# Role
你是一位拥有10年经验的资深大模型（LLM）高级产品专家。你精通如何将复杂的AI底层能力（如RAG、Agent、微调、Prompt工程、LLMOps）转化为符合用户直觉、业务逻辑严密、可直接交付给研发和设计团队的落地方案。

# Goal
请根据用户提供的【产品基本信息】，生成一份结构严密、逻辑闭环、可以直接用于开发评审的**详细产品需求文档（PRD）**。

# Style & Principles (极其重要)
1. 去AI味：禁止出现"随着AI技术的飞速发展""在当今数字化转型背景下"等假大空套话。开门见山，直接切入核心痛点。
2. 拒绝常识堆砌：不要只写"界面要美观""系统要稳定"这种废话。请写出具体的技术指标或可量化的产品规则。
3. 突出LLM独特性：必须包含大模型应用特有的产品设计逻辑（幻觉控制、流式传输、Token成本控制、降级兜底方案、输入输出安全审核、Prompt工程管理等）。
4. 结构清晰：善用 Markdown 的粗体、表格、水平线(---) 和块引用(>) 保障极佳可读性。

# PRD Structure Requirement
输出必须包含以下核心章节，且各章节需深度展开（用 ## 二级标题分章）：

## 1. 文档基本信息
产品名称、版本号（V1.0.0起步）、撰写人、发布日期、审批状态。用表格呈现。

## 2. 产品概述与核心价值
- **核心痛点**：目标用户在没有这个产品前，如何痛苦地完成任务？
- **解决方案**：本产品如何通过大模型能力重构这个工作流？
- **核心价值**：对用户的量化价值（如提升XX%效率、降低XX%成本）。

## 3. 用户角色与典型场景
用**表格**呈现，列：用户角色、核心痛点、典型应用场景（至少3个角色）。

## 4. 核心功能需求
针对最核心的3-4个模块深度拆解。每个模块包含：① 需求描述（做什么）；② 详细交互逻辑（用户怎么用、系统怎么响应）；③ LLM特有逻辑（调用什么模型、Prompt表单化、RAG召回机制、引用溯源交互等）。

## 5. 非功能需求
- **性能与体验**：首字响应时间(TTFT)、并发支持、流式打字机效果、自动保存机制。
- **LLM专属质量指标**：上下文窗口(Context Window)处理策略、输入输出合规过滤机制、内容幻觉抑制方案。

## 6. 埋点与数据看板需求
运营指标、大模型专用监控指标（Input/Output Tokens 消耗统计、Prompt 热度、用户点赞/点踩反馈闭环）。用表格列出关键埋点。

## 7. 风险与应对策略
必须包含：API 宕机/超时的**降级与熔断机制**；Token 成本超支的限制策略。用表格呈现（风险 / 影响 / 应对）。

全程中文输出，专业、具体、可落地。`

app.post('/api/prd', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const p = req.body?.product || {}
  const userMsg =
    `# 以下是我的产品基本信息：\n\n` +
    `* 产品名称：${p.name || '(未填)'}\n` +
    `* 目标用户：${p.users || '(未填)'}\n` +
    `* 核心大模型能力：${p.capability || '(未填)'}\n` +
    `* 核心痛点：${p.painpoint || '(未填)'}\n` +
    (p.extra ? `* 补充说明：${p.extra}\n` : '') +
    `\n请据此生成完整 PRD。`
  try {
    for await (const t of streamText({
      ...req.body,
      system: PRD_SYS,
      messages: [{ role: 'user', content: userMsg }],
      effort: 'medium',
      max_tokens: 8000,
    })) {
      res.write(t)
    }
    res.end()
  } catch (e) {
    res.write(`\n\n⚠️ 生成失败：${e?.message || e}`)
    res.end()
  }
})

// --- Proposal generation: framework-logic-first, fixed modules (streamed Markdown) ---
const PROPOSAL_SYS = `你是资深 AI 产品策略顾问，为"把某个产品用某种 LLM 范式升级/落地"撰写一份**提案方案**。
原则：开门见山、去 AI 味、拒绝套话；结合具体产品与范式给出可决策、逻辑闭环的内容；写具体数字与判断，不要常识堆砌。善用 Markdown 粗体、表格、块引用(>)、水平线(---)。

严格按以下结构输出（## 二级标题，顺序不变）：

## 0. 整体框架逻辑
先用一段话讲清这份提案的主线逻辑（为什么做 → 做什么 → 怎么落地 → 预期收益）；再用一个表格列出后续各模块（背景 / 目标 / 数据 / 升级策略 / Demo / 需求分析 / 市场分析 / 预期计划）各自要回答的核心问题与结论摘要，让评审一眼看懂整体框架。

## 1. 背景
产品现状、核心痛点、为什么是现在（结合行业与该范式的时机窗口）。

## 2. 目标
量化的业务目标 + 体验目标；明确"目标"与"非目标"。

## 3. 数据
现有数据资产与关键指标基线；本提案要监测的核心指标；数据如何支撑决策与验证。用表格。

## 4. 升级策略
如何把产品按该范式分阶段升级落地：核心改造点、关键路径，以及 LLM 特有设计（RAG / Agent / 长期记忆 / Prompt 工程 / 降级兜底 / Token 成本控制 / 安全审核）。

## 5. Demo
最小可玩 Demo 设想：界面、核心交互、用到的模型能力、要验证的关键假设。

## 6. 需求分析
用户需求与场景拆解、优先级。用表格（需求 / 角色 / 优先级 / 价值）。

## 7. 市场分析
市场规模与趋势、竞品对比（表格）、差异化与护城河判断。

## 8. 预期计划
里程碑与排期（表格：阶段 / 时间 / 目标 / 交付物）、预期收益与主要风险。
若用户提供了【商业化方案】与【ROI/收入预估】，本节**必须**包含一张收入预测表（列：情景 / 期内收入 / 净利润 / ROI / 回本周期），引用所给数字，并据此说明预期收益，不要另编一套。

全程中文，专业、具体、可落地。`

function roiCalcServer(s, horizon) {
  const users = +s.users || 0, payRate = +s.payRate || 0, arpu = +s.arpuMonthly || 0, gm = +s.grossMargin || 0, cac = +s.cac || 0, fc = +s.fixedCostMonthly || 0
  const paying = users * payRate / 100, mrr = paying * arpu, revenue = mrr * horizon
  const gp = revenue * gm / 100, acq = paying * cac, fixed = fc * horizon, invest = acq + fixed
  const net = gp - acq - fixed
  const roi = invest > 0 ? net / invest : net > 0 ? Infinity : 0
  const monthlyNet = mrr * gm / 100 - fc
  const payback = net <= 0 ? Infinity : monthlyNet > 0 ? invest / monthlyNet : Infinity
  return { revenue, net, roi, payback }
}
function fmtNum(n) { if (!isFinite(n)) return '∞'; const a = Math.abs(n); if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿'; if (a >= 1e4) return (n / 1e4).toFixed(1) + '万'; return Math.round(n).toString() }
function financialContext(mon, roi) {
  let out = ''
  if (mon?.model) out += `\n\n【商业化方案】模式：${mon.model}；定价：${(mon.pricing || []).map((t) => `${t.tier} ${t.price}(${t.forWho})`).join('；')}`
  if (roi?.scenarios?.length) {
    const cur = roi.currency || '元', h = roi.horizonMonths || 12
    const lines = roi.scenarios.map((s) => { const k = roiCalcServer(s, h); return `- ${s.name}：期内收入 ${cur}${fmtNum(k.revenue)}，净利润 ${cur}${fmtNum(k.net)}，ROI ${isFinite(k.roi) ? Math.round(k.roi * 100) + '%' : '∞'}，回本 ${isFinite(k.payback) ? Math.ceil(k.payback) + '月' : '—'}` }).join('\n')
    out += `\n\n【ROI/收入预估】货币 ${cur}，评估期 ${h} 个月：\n${lines}`
  }
  return out
}

app.post('/api/proposal', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const b = req.body || {}
  const p = b.product || {}
  const userMsg =
    `【目标范式】${b.paradigm || ''}（${b.paradigmDesc || ''}）\n\n` +
    `【产品基本信息】\n${productRecap(p)}${financialContext(b.monetization, b.roi)}\n\n请据此生成完整提案方案。`
  try {
    for await (const t of streamText({
      ...b,
      system: PROPOSAL_SYS,
      messages: [{ role: 'user', content: userMsg }],
      effort: 'medium',
      max_tokens: 8000,
    })) {
      res.write(t)
    }
    res.end()
  } catch (e) {
    res.write(`\n\n⚠️ 生成失败：${e?.message || e}`)
    res.end()
  }
})

// --- Slide deck: condense a doc into presentation-ready slides (structured) ---
const SLIDES_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            table: {
              type: 'object',
              properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              },
              required: ['headers', 'rows'],
              additionalProperties: false,
            },
          },
          required: ['title', 'bullets'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'subtitle', 'slides'],
    additionalProperties: false,
  },
}

app.post('/api/slides', async (req, res) => {
  const b = req.body || {}
  const md = (b.md || '').toString().slice(0, 12000)
  const sys =
    '你是演示文稿专家。把用户给的提案/文档转成一套用于路演的幻灯片 JSON。要求：\n' +
    '- title/subtitle 作为封面；\n' +
    '- 10-14 页 slides，覆盖文档主要章节；每页 title + 3-6 条 bullets，每条 ≤ 20 字，提炼核心、不要照抄长句；\n' +
    '- 涉及"计划/排期""市场/竞品""数据指标"的页用 table(headers + rows) 呈现，rows ≤ 5 行、列 ≤ 4；这类页 bullets 可只放 1-2 条概述；\n' +
    '- 中文，措辞精炼有力。'
  try {
    const text = await completeText({
      ...b,
      system: sys,
      messages: [{ role: 'user', content: md }],
      format: SLIDES_SCHEMA,
      effort: 'low',
      max_tokens: 4000,
    })
    res.json(parseModelJson(text))
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// --- Build an interactive HTML demo from a spec (streamed) ---
const DEMO_SYS = `你是资深前端工程师 + 交互设计师。根据用户给的「Demo 设想」，产出一个**单文件、自包含、可直接运行**的可交互 HTML 原型。

硬性要求：
1. 只输出三部分：一个 <style>、HTML 结构、一个 <script>。不要输出 <!doctype>/<html>/<head>/<body>，不要 markdown 代码块或任何解释文字。
2. 零外部依赖：不许 import、不许引用任何 CDN / 外链字体 / 图片 URL。所有逻辑内联在 <script> 里。
3. 视觉：深色主题（背景接近 #0c0e14，文字浅色，主强调色用 #7c9cff），现代、留白舒适、移动端自适应；可用 emoji 当图标。
4. **真实 AI 能力**：凡是需要"AI 回答/分析/推荐/生成"的地方，调用已注入的全局异步函数 \`await AI(prompt, { system })\`，它返回模型生成的字符串（可能较慢，要有 loading 态）。不要自己写假数据糊弄——把真实意图组织成 prompt 调 AI()。
5. 交互完整：输入、按钮、loading、结果展示都要能用；至少覆盖设想里描述的核心交互。
6. 代码健壮：用 try/catch 包住 AI() 调用，失败时在界面显示错误，不要静默。

直接开始输出 <style>。`

app.post('/api/build-demo', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const b = req.body || {}
  const userMsg =
    `【范式】${b.paradigm || ''}\n【产品】${b.productName || ''}\n\n【Demo 设想】\n${b.spec || ''}\n\n` +
    '请据此生成可交互 HTML 原型。'
  try {
    for await (const t of streamText({
      ...b,
      system: DEMO_SYS,
      messages: [{ role: 'user', content: userMsg }],
      effort: 'medium',
      max_tokens: 8000,
    })) {
      res.write(t)
    }
    res.end()
  } catch (e) {
    res.write(`\n\n⚠️ 生成失败：${e?.message || e}`)
    res.end()
  }
})

// --- Parallel PRD: shared outline (phase A) + per-chapter generation (phase B) ---
const OUTLINE_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      tagline: { type: 'string' },
      version: { type: 'string' },
      personas: {
        type: 'array',
        items: {
          type: 'object',
          properties: { role: { type: 'string' }, scene: { type: 'string' } },
          required: ['role', 'scene'],
          additionalProperties: false,
        },
      },
      modules: { type: 'array', items: { type: 'string' } },
    },
    required: ['tagline', 'version', 'personas', 'modules'],
    additionalProperties: false,
  },
}

function productRecap(p = {}) {
  return (
    `产品名称：${p.name || '(未填)'}\n目标用户：${p.users || '(未填)'}\n` +
    `核心大模型能力：${p.capability || '(未填)'}\n核心痛点：${p.painpoint || '(未填)'}` +
    (p.extra ? `\n补充：${p.extra}` : '')
  )
}

app.post('/api/prd-outline', async (req, res) => {
  const product = req.body?.product || {}
  const sys =
    '你是资深 LLM 产品专家。基于产品信息，给出该 PRD 的"共享骨架"，供后续各章节保持一致：' +
    'tagline(一句话价值主张)、version(从 V1.0.0 起)、personas(3-4 个用户角色，每个含 role 与 scene)、' +
    'modules(3-4 个核心功能模块名)。中文，精炼具体，不要套话。'
  try {
    const text = await completeText({
      ...req.body,
      system: sys,
      messages: [{ role: 'user', content: productRecap(product) }],
      format: OUTLINE_SCHEMA,
      effort: 'low',
      max_tokens: 1200,
    })
    res.json(parseModelJson(text))
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

app.post('/api/prd-section', async (req, res) => {
  const product = req.body?.product || {}
  const outline = req.body?.outline || {}
  const ch = req.body?.chapter || {}
  const personas = Array.isArray(outline.personas) ? outline.personas.map((x) => x.role).filter(Boolean).join('、') : ''
  const modules = Array.isArray(outline.modules) ? outline.modules.join('、') : ''
  const sys =
    `你是拥有10年经验的资深 LLM 产品专家，正在撰写产品《${product.name || ''}》的 PRD 中的某一章。\n` +
    `共享骨架（务必与之保持一致）：\n- 价值主张：${outline.tagline || ''}\n- 版本：${outline.version || 'V1.0.0'}\n` +
    `- 用户角色：${personas}\n- 核心模块：${modules}\n\n` +
    '写作原则：① 去 AI 味，开门见山，禁止假大空套话；② 拒绝常识堆砌，写具体技术指标或可量化规则；' +
    '③ 突出 LLM 独特性（幻觉控制/流式传输/Token 成本/降级兜底/输入输出安全审核/Prompt 工程/RAG 召回与溯源）；' +
    '④ 善用 Markdown 粗体、表格、块引用(>)、水平线。\n' +
    `严格只输出本章内容，以 \`## ${ch.id}. ${ch.title}\` 开头，不要写其他章节、不要任何前言或结语。\n\n` +
    `本章撰写要求：${ch.brief || ''}`
  try {
    const text = await completeText({
      ...req.body,
      system: sys,
      messages: [{ role: 'user', content: '产品基本信息：\n' + productRecap(product) }],
      effort: 'medium',
      max_tokens: ch.maxTokens || 2200,
    })
    res.json({ text })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// --- Non-streaming completion, optionally with a structured-output schema ---
app.post('/api/complete', async (req, res) => {
  try {
    const text = await completeText(req.body)
    res.json({ text })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// --- Answer engine: server-side web search (Claude & DeepSeek) with graceful fallback ---
const ANSWER_SYS =
  '你是一个答案引擎。先用 web_search 检索最新信息，再用中文给出结构化、准确、简洁的回答：' +
  '开头一句话直接结论，然后分点展开，必要时给出数字与时间。不要复述问题。'
const ANSWER_SYS_NOWEB =
  '你是一个答案引擎。用中文给出结构化、准确、简洁的回答：开头一句话直接结论，然后分点展开。' +
  '如果信息可能过时，请明确说明。不要复述问题。'

// Run a web-search-backed turn over the Anthropic Messages protocol (Claude or DeepSeek /anthropic),
// looping through pause_turn pauses. Returns { text, sources }.
async function webSearchTurn(b, { system, query, max_tokens = 2048, maxLoops = 4 }) {
  const { client, model, tools } = webSearchSetup(b)
  let messages = [{ role: 'user', content: query }]
  let resp = await client.messages.create({ model, max_tokens, system, tools, messages })
  let guard = 0
  while (resp.stop_reason === 'pause_turn' && guard++ < maxLoops) {
    messages = [{ role: 'user', content: query }, { role: 'assistant', content: resp.content }]
    resp = await client.messages.create({ model, max_tokens, system, tools, messages })
  }
  const text = resp.content.filter((x) => x.type === 'text').map((x) => x.text).join('')
  const seen = new Set()
  const sources = []
  for (const blk of resp.content) {
    if (blk.type === 'text' && Array.isArray(blk.citations)) {
      for (const c of blk.citations) {
        if (c?.url && !seen.has(c.url)) {
          seen.add(c.url)
          sources.push({ title: c.title || c.url, url: c.url })
        }
      }
    }
  }
  return { text, sources }
}

app.post('/api/answer', async (req, res) => {
  const b = req.body || {}
  const query = (b.query || '').toString().slice(0, 2000)
  if (!query.trim()) return res.status(400).json({ error: 'empty query' })

  try {
    const { text, sources } = await webSearchTurn(b, { system: ANSWER_SYS, query })
    res.json({ text, sources })
  } catch (e) {
    try {
      const text = await completeText({ ...b, system: ANSWER_SYS_NOWEB, messages: [{ role: 'user', content: query }], max_tokens: 2048, format: null })
      res.json({ text, sources: [], note: 'web search 不可用，已改用模型内置知识回答（可能不含最新信息）。' })
    } catch (e2) {
      res.status(500).json({ error: e2?.message || String(e2) })
    }
  }
})

// --- Product advisor: diagnose a product + goal, recommend a paradigm ---
const PARADIGM_IDS = [
  'chat', 'companion', 'create', 'copilot', 'agent', 'answer', 'router',
  'rag', 'bizcopilot', 'support', 'bizagent', 'bi', 'docintel', 'platform',
]
const PARADIGM_BRIEF = `
【toC】
chat 对话即产品：LLM 即界面，用户自带任务。适合通用助手。
companion 角色陪伴：人格化角色，卖情感与时长。适合陪伴/娱乐/社交。
create 创作工具：可反复打磨的产出物，人在环里。适合内容/设计/生产力。
copilot 嵌入式 Copilot：把 AI 塞进已有高频场景，0 迁移成本。适合已有产品提粘性。
agent 任务代理：给目标自动拆解执行，人只验收。适合复杂多步任务。
answer 答案引擎：AI 隐形，用 AI 重做某个老品类拉开体验代差。适合搜索/问答/决策。
router 聚合/路由层：聚合多模型做分发与对比。适合平台/入口/开发者。
【toB】
rag 企业知识库问答：把企业文档变成可问答、可溯源的知识中枢。适合内部知识/客服/售前/合规。
bizcopilot 行业 SaaS 副驾：嵌入 CRM/HR/法务等业务系统，读写业务对象。适合给已有 B 端系统提效。
support 智能客服：自动应答 + 坐席辅助，可溯源可转人工。适合客服/售后/服务台。
bizagent 流程自动化 Agent：跨系统执行业务流程，不可逆动作人工审批。适合订单/运维/财务/HR 流程。
bi 对话式数据分析：自然语言转 SQL、自助查数出报表。适合 BI/经营分析/降低看数门槛。
docintel 文档智能：合同/发票/报告的抽取、审阅、比对。适合法务/采购/财务等文档密集场景。
platform 企业 AI 平台：统一模型接入、Agent 编排、评测监控与护栏治理。适合企业 AI 中台/平台团队。
`

const ADVISE_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      diagnosis: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, insight: { type: 'string' } },
          required: ['title', 'insight'],
          additionalProperties: false,
        },
      },
      recommended: { type: 'string', enum: PARADIGM_IDS },
      paradigmName: { type: 'string' },
      why: { type: 'string' },
      runnerUp: { type: 'string', enum: PARADIGM_IDS },
      runnerUpWhy: { type: 'string' },
      productProposal: { type: 'string' },
      demoIdea: { type: 'string' },
      cautions: { type: 'array', items: { type: 'string' } },
    },
    required: ['diagnosis', 'recommended', 'paradigmName', 'why', 'productProposal', 'demoIdea', 'cautions'],
    additionalProperties: false,
  },
}

app.post('/api/advise', async (req, res) => {
  const b = req.body || {}
  const product = b.product || {}
  const goal = (b.goal || '').toString().slice(0, 2000)
  const sys =
    `你是资深 AI 产品顾问，熟悉 LLM toC 产品的 7 种范式：\n${PARADIGM_BRIEF}\n` +
    '用户会给出他们的产品信息和目标/问题。请输出：\n' +
    '1) diagnosis：3-4 步"专家诊断"，每步一个角度(title)+一针见血的洞察(insight)，像顾问当面对话一样具体、犀利、可落地，结合用户产品本身，不要空泛套话；\n' +
    '2) recommended：从 7 个范式 id 里选最合适的一个；paradigmName 给中文名；why 给推荐理由（结合该产品的目标/问题）；\n' +
    '3) runnerUp / runnerUpWhy：次优范式及一句话理由（可选但尽量给）；\n' +
    '4) productProposal：把推荐范式具体应用到"用户这个产品"的方案，结合其定位/人群/功能给出具体形态，而非通用描述；\n' +
    '5) demoIdea：对应的最小可玩 demo 设想（界面 + 核心交互 + 用到的模型能力）；\n' +
    '6) cautions：该产品落地这个范式要注意的 3-5 个要点。\n' +
    '全部中文，具体、不空泛。'
  const userMsg =
    `【产品信息】\n名称：${product.name || '(未填)'}\n定位：${product.positioning || '(未填)'}\n` +
    `目标人群：${product.audience || '(未填)'}\n界面/形态：${product.ui || '(未填)'}\n` +
    `主要功能：${product.features || '(未填)'}\n${product.stage ? `阶段：${product.stage}\n` : ''}` +
    `\n【目标 / 当前问题】\n${goal || '(未填)'}`
  try {
    const text = await completeText({
      ...b,
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
      format: ADVISE_SCHEMA,
      effort: 'medium',
      max_tokens: 6000,
    })
    let obj
    try {
      obj = parseModelJson(text)
    } catch {
      // last resort: ask the model to repair its own JSON
      const fixed = await completeText({
        ...b,
        system: '你是 JSON 修复器。把用户给的文本修复成合法 JSON，只输出 JSON 本身，不要解释、不要代码块。',
        messages: [{ role: 'user', content: text }],
        effort: 'low',
        max_tokens: 6000,
        format: ADVISE_SCHEMA,
      })
      obj = parseModelJson(fixed)
    }
    res.json(obj)
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// --- Competitor analysis: research (web) → structured report mapped to our paradigms ---
const RESEARCH_SYS =
  '你是产品研究员。用 web_search 检索该产品的最新公开信息：定位、目标用户、核心功能、商业模式、口碑与近况。' +
  '输出一段简洁、事实性的中文 dossier，尽量具体（功能、数字、模式），不要展开评价。'
const RESEARCH_SYS_NOWEB =
  '你是产品研究员。用你已知的信息，简洁、事实性地描述该产品：定位、目标用户、核心功能、商业模式、口碑。' +
  '中文；若信息可能过时请说明，不要编造具体数字。'

const COMPETE_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      overview: { type: 'string' },
      category: { type: 'string', enum: ['toC', 'toB', 'both'] },
      paradigms: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string', enum: PARADIGM_IDS }, role: { type: 'string', enum: ['主要', '次要'] }, reason: { type: 'string' } },
          required: ['id', 'role', 'reason'],
          additionalProperties: false,
        },
      },
      pros: { type: 'array', items: { type: 'string' } },
      cons: { type: 'array', items: { type: 'string' } },
      highlights: { type: 'array', items: { type: 'string' } },
      insights: { type: 'array', items: { type: 'string' } },
    },
    required: ['overview', 'category', 'paradigms', 'pros', 'cons', 'highlights', 'insights'],
    additionalProperties: false,
  },
}

app.post('/api/compete', async (req, res) => {
  const b = req.body || {}
  const name = (b.name || '').toString().slice(0, 200)
  if (!name.trim()) return res.status(400).json({ error: '请填写产品名' })
  const query = `产品：${name}\n官网/链接：${b.url || '(未提供)'}\n补充说明：${b.notes || '(无)'}`

  // Phase A: research via server-side web search (Claude & DeepSeek); knowledge fallback otherwise
  let dossier = ''
  let sources = []
  let note = ''
  try {
    const r = await webSearchTurn(b, { system: RESEARCH_SYS, query, max_tokens: 1800 })
    dossier = r.text
    sources = r.sources
  } catch (e) {
    dossier = ''
  }
  if (!dossier) {
    try {
      dossier = await completeText({ ...b, system: RESEARCH_SYS_NOWEB, messages: [{ role: 'user', content: query }], max_tokens: 1500 })
      note = 'web 检索不可用，已用模型内置知识分析（可能不含最新信息）。'
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) })
    }
  }

  // Phase B: structure into a paradigm-mapped report
  const structSys =
    `你是 LLM 产品分析师，精通下面 14 种 LLM 产品范式：\n${PARADIGM_BRIEF}\n` +
    '基于给定资料，对该产品做竞品分析，输出：\n' +
    'overview(产品是什么、面向谁，2-3 句)；category(toC/toB/both)；\n' +
    'paradigms(它采用了哪些范式，id 必须取自上面集合，role 标主要/次要，reason 说明依据)；\n' +
    'pros(做得好的点)、cons(不足/风险)、highlights(关键设计/数据/商业模式的观察)、insights(对做同类产品的具体启发)。\n' +
    '判断要有依据、具体，不要空泛套话。中文。'
  try {
    const text = await completeText({
      ...b,
      system: structSys,
      messages: [{ role: 'user', content: `产品名：${name}\n\n【资料 dossier】\n${dossier}` }],
      format: COMPETE_SCHEMA,
      effort: 'medium',
      max_tokens: 3000,
    })
    let report
    try { report = parseModelJson(text) }
    catch {
      const fixed = await completeText({ ...b, system: '你是 JSON 修复器，只输出合法 JSON，不要解释或代码块。', messages: [{ role: 'user', content: text }], format: COMPETE_SCHEMA, effort: 'low', max_tokens: 3000 })
      report = parseModelJson(fixed)
    }
    res.json({ report, sources, note })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// --- Multi-product comparison ---
async function researchProduct(b, p) {
  const query = `产品：${p.name}\n官网/链接：${p.url || '(未提供)'}\n补充：${p.notes || '(无)'}`
  let dossier = ''
  let sources = []
  let note = ''
  try {
    const r = await webSearchTurn(b, { system: RESEARCH_SYS, query, max_tokens: 1500, maxLoops: 3 })
    dossier = r.text
    sources = r.sources
  } catch { dossier = '' }
  if (!dossier) {
    dossier = await completeText({ ...b, system: RESEARCH_SYS_NOWEB, messages: [{ role: 'user', content: query }], max_tokens: 1200 })
    note = 'web 检索部分不可用，含模型内置知识。'
  }
  return { dossier, sources, note }
}

const COMPARE_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      products: { type: 'array', items: { type: 'string' } },
      paradigms: {
        type: 'array',
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', enum: PARADIGM_IDS }, role: { type: 'string', enum: ['主要', '次要'] } }, required: ['id', 'role'], additionalProperties: false } },
      },
      rows: { type: 'array', items: { type: 'object', properties: { aspect: { type: 'string' }, cells: { type: 'array', items: { type: 'string' } } }, required: ['aspect', 'cells'], additionalProperties: false } },
      takeaways: { type: 'array', items: { type: 'string' } },
    },
    required: ['products', 'paradigms', 'rows', 'takeaways'],
    additionalProperties: false,
  },
}

app.post('/api/compare', async (req, res) => {
  const b = req.body || {}
  const products = (b.products || []).filter((p) => p?.name?.trim()).slice(0, 4)
  if (products.length < 2) return res.status(400).json({ error: '请至少填写 2 个产品' })
  try {
    const researched = await Promise.all(products.map((p) => researchProduct(b, p)))
    const dossiers = products.map((p, i) => `### 产品${i + 1}：${p.name}\n${researched[i].dossier}`).join('\n\n')
    const seen = new Set()
    const sources = []
    researched.flatMap((r) => r.sources).forEach((s) => { if (!seen.has(s.url)) { seen.add(s.url); sources.push(s) } })
    const note = researched.find((r) => r.note)?.note || ''

    const sys =
      `你是 LLM 产品分析师，精通下面 14 种范式：\n${PARADIGM_BRIEF}\n` +
      '基于多个产品的资料做横向对比，输出：\n' +
      'products(产品名数组，顺序与输入一致)；\n' +
      'paradigms(与 products 等长：每个元素是该产品采用的范式列表 {id 取自集合, role 主要/次要})；\n' +
      'rows(对比维度，每行 {aspect 维度名, cells 与 products 等长})，维度建议含：一句话定位、目标用户、核心能力、商业模式、突出优势、主要短板、差异化打法；\n' +
      'takeaways(横向看下来的关键差异与启发)。中文，具体不空泛。'
    const text = await completeText({ ...b, system: sys, messages: [{ role: 'user', content: dossiers }], format: COMPARE_SCHEMA, effort: 'medium', max_tokens: 4000 })
    let report
    try { report = parseModelJson(text) }
    catch {
      const fixed = await completeText({ ...b, system: '你是 JSON 修复器，只输出合法 JSON。', messages: [{ role: 'user', content: text }], format: COMPARE_SCHEMA, effort: 'low', max_tokens: 4000 })
      report = parseModelJson(fixed)
    }
    res.json({ report, sources, note })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// --- Paradigm fit: score a product against all 14 paradigms ---
const FIT_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      scores: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', enum: PARADIGM_IDS }, score: { type: 'integer' }, reason: { type: 'string' } }, required: ['id', 'score', 'reason'], additionalProperties: false } },
      summary: { type: 'string' },
    },
    required: ['scores', 'summary'],
    additionalProperties: false,
  },
}
app.post('/api/fit', async (req, res) => {
  const p = req.body?.product || {}
  const sys =
    `你是 LLM 产品策略专家，熟悉下面 14 种范式：\n${PARADIGM_BRIEF}\n` +
    '基于产品信息，为**每一个**范式打契合度分数(0-100，表示该产品采用此范式的合适程度)，并给一句话理由(reason)。' +
    '必须覆盖全部 14 个 id。summary 用一两句话点出最契合的方向。中文，判断有依据。'
  const msg = `名称：${p.name || ''}\n定位：${p.positioning || ''}\n人群：${p.audience || ''}\n形态：${p.ui || ''}\n功能：${p.features || ''}`
  try {
    const text = await completeText({ ...req.body, system: sys, messages: [{ role: 'user', content: msg }], format: FIT_SCHEMA, effort: 'medium', max_tokens: 3000 })
    res.json(parseModelJson(text))
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }) }
})

// --- Red-team review of a generated document ---
const REVIEW_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      overall: { type: 'integer' },
      dimensions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, score: { type: 'integer' }, comment: { type: 'string' } }, required: ['name', 'score', 'comment'], additionalProperties: false } },
      issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['高', '中', '低'] }, point: { type: 'string' } }, required: ['severity', 'point'], additionalProperties: false } },
      improvements: { type: 'array', items: { type: 'string' } },
    },
    required: ['overall', 'dimensions', 'issues', 'improvements'],
    additionalProperties: false,
  },
}
app.post('/api/review', async (req, res) => {
  const b = req.body || {}
  const doc = (b.doc || '').toString().slice(0, 14000)
  const kind = b.kind || '文档'
  const sys =
    `你是资深产品评审 + 红队，对一份「${kind}」严格挑刺。从这些维度逐一评分(0-100)并点评：` +
    '可行性、商业逻辑、技术合理性(尤其 LLM 特有：幻觉/成本/降级/安全)、需求清晰度、风险与遗漏、完整性。' +
    'overall 给总分；issues 列出具体问题(标严重度 高/中/低)；improvements 给可执行的改进建议。中文，犀利、具体、对事不对人。'
  try {
    const text = await completeText({ ...b, system: sys, messages: [{ role: 'user', content: doc }], format: REVIEW_SCHEMA, effort: 'medium', max_tokens: 2500 })
    res.json(parseModelJson(text))
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }) }
})

// --- Business Model Canvas ---
const BMC_KEYS = ['customerSegments', 'valuePropositions', 'channels', 'customerRelationships', 'revenueStreams', 'keyResources', 'keyActivities', 'keyPartners', 'costStructure']
const BMC_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: Object.fromEntries(BMC_KEYS.map((k) => [k, { type: 'array', items: { type: 'string' } }])),
    required: BMC_KEYS,
    additionalProperties: false,
  },
}
app.post('/api/bmc', async (req, res) => {
  const p = req.body?.product || {}
  const sys =
    '你是商业模式专家。基于产品信息填写商业模式画布的九个要素，每个 3-5 条要点，具体不空泛：' +
    'customerSegments(客户细分)、valuePropositions(价值主张)、channels(渠道)、customerRelationships(客户关系)、' +
    'revenueStreams(收入来源)、keyResources(核心资源)、keyActivities(关键业务)、keyPartners(重要伙伴)、costStructure(成本结构)。中文。'
  const msg = `名称：${p.name || ''}\n定位：${p.positioning || ''}\n人群：${p.audience || ''}\n形态：${p.ui || ''}\n功能：${p.features || ''}`
  try {
    const text = await completeText({ ...req.body, system: sys, messages: [{ role: 'user', content: msg }], format: BMC_SCHEMA, effort: 'medium', max_tokens: 2500 })
    res.json(parseModelJson(text))
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }) }
})

// --- Revise a document based on its red-team review (streamed) ---
app.post('/api/revise', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const b = req.body || {}
  const kind = b.kind || '文档'
  const doc = (b.doc || '').toString().slice(0, 16000)
  const r = b.review || {}
  const issues = (r.issues || []).map((it) => `- [${it.severity}] ${it.point}`).join('\n')
  const improvements = (r.improvements || []).map((x) => `- ${x}`).join('\n')
  const reviewText = `总分：${r.overall ?? '-'}\n\n问题：\n${issues || '（无）'}\n\n改进建议：\n${improvements || '（无）'}`
  const sys =
    `你是资深产品经理。根据红队评审意见，对这份「${kind}」做**实质性修订**：逐条回应评审中的问题与改进建议，补强薄弱环节，` +
    '保持并优化 Markdown 结构（标题、表格、列表、块引用）。输出**完整修订后的文档**（不是 diff、不要只列改动）。' +
    '开头加一行 `> 本次修订要点：…` 简述改了什么，然后给完整文档。中文，具体落地。'
  try {
    for await (const t of streamText({
      ...b,
      system: sys,
      messages: [{ role: 'user', content: `【原文】\n${doc}\n\n【红队评审意见】\n${reviewText}` }],
      effort: 'medium',
      max_tokens: 8000,
    })) {
      res.write(t)
    }
    res.end()
  } catch (e) {
    res.write(`\n\n⚠️ 修订失败：${e?.message || e}`)
    res.end()
  }
})

// --- Commercialization strategy: monetization & conversion logic for a paradigm ---
const MONETIZE_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string' },
      modelReason: { type: 'string' },
      funnel: { type: 'array', items: { type: 'object', properties: { stage: { type: 'string' }, goal: { type: 'string' }, levers: { type: 'array', items: { type: 'string' } }, metric: { type: 'string' } }, required: ['stage', 'goal', 'levers', 'metric'], additionalProperties: false } },
      pricing: { type: 'array', items: { type: 'object', properties: { tier: { type: 'string' }, price: { type: 'string' }, forWho: { type: 'string' }, includes: { type: 'array', items: { type: 'string' } }, value: { type: 'integer' }, upgradeTrigger: { type: 'string' } }, required: ['tier', 'price', 'forWho', 'includes', 'value', 'upgradeTrigger'], additionalProperties: false } },
      pricingLogic: { type: 'array', items: { type: 'string' } },
      conversionLogic: { type: 'array', items: { type: 'string' } },
      metrics: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
    },
    required: ['model', 'modelReason', 'funnel', 'pricing', 'pricingLogic', 'conversionLogic', 'metrics', 'risks'],
    additionalProperties: false,
  },
}
app.post('/api/monetize', async (req, res) => {
  const p = req.body?.product || {}
  const paradigm = req.body?.paradigm || ''
  const pdesc = req.body?.paradigmDesc || ''
  const sys =
    `你是商业化策略专家。基于产品及其最契合的 LLM 范式「${paradigm}」（${pdesc}），设计**商业化转化逻辑**：\n` +
    '- model：最适合该范式的商业化模式（订阅 / 用量计费 / Freemium / 增值服务 / 按席位 / 平台抽成 / 广告 等），modelReason 说明为何适配该范式；\n' +
    '- funnel：转化漏斗 4-6 个阶段（如 获取→激活→付费转化→留存→扩展增购），每阶段给 goal、levers(具体手段/杠杆)、metric(衡量指标)；\n' +
    '- pricing：2-4 个定价档位（tier 名称 / price 价格 / forWho 面向谁 / includes 含哪些），按价值从低到高排序；' +
    '每档再给 value(0-100，表示该档的价值/定位高度，逐档递增) 和 upgradeTrigger(从上一档升级到本档的触发点；第一档写"入门/获客点")；\n' +
    '- pricingLogic：定价逻辑 3-5 条，讲清为什么这么定（定价依据：按价值/成本/竞品锚定；档位如何切分与各档卡点；锚定与升级路径；以及该范式特有的计价单位，如按席位/按调用量/按成果/按角色情感价值）；\n' +
    '- conversionLogic：免费→付费的核心钩子与转化逻辑（为什么用户愿意付费、卡点在哪）；\n' +
    '- metrics：关键商业化指标（如 付费转化率 / ARPU / LTV / CAC / NDR / 续费率）；risks：商业化风险与注意。\n' +
    '务必结合该范式的变现特性（如陪伴卖情感订阅、创作按产出量、Agent 按成果/任务计费、Copilot 提粘性走席位、答案引擎订阅+API、企业 RAG 按席位/调用量、平台层抽成）。中文，具体可落地。'
  const msg = `名称：${p.name || ''}\n定位：${p.positioning || ''}\n人群：${p.audience || ''}\n形态：${p.ui || ''}\n功能：${p.features || ''}`
  try {
    const text = await completeText({ ...req.body, system: sys, messages: [{ role: 'user', content: msg }], format: MONETIZE_SCHEMA, effort: 'medium', max_tokens: 3000 })
    res.json(parseModelJson(text))
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }) }
})

// --- ROI / revenue projection (assumptions; client computes & lets user tweak) ---
const ROI_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      currency: { type: 'string' },
      horizonMonths: { type: 'integer' },
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            users: { type: 'number' },
            payRate: { type: 'number' },
            arpuMonthly: { type: 'number' },
            grossMargin: { type: 'number' },
            cac: { type: 'number' },
            fixedCostMonthly: { type: 'number' },
          },
          required: ['name', 'users', 'payRate', 'arpuMonthly', 'grossMargin', 'cac', 'fixedCostMonthly'],
          additionalProperties: false,
        },
      },
      assumptionNotes: { type: 'array', items: { type: 'string' } },
      drivers: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
    },
    required: ['currency', 'horizonMonths', 'scenarios', 'assumptionNotes', 'drivers', 'risks'],
    additionalProperties: false,
  },
}
app.post('/api/roi', async (req, res) => {
  const p = req.body?.product || {}
  const paradigm = req.body?.paradigm || ''
  const pdesc = req.body?.paradigmDesc || ''
  const mon = req.body?.monetization
  const monText = mon ? `\n【商业化方案】模式：${mon.model || ''}；定价：${(mon.pricing || []).map((t) => `${t.tier} ${t.price}(${t.forWho})`).join('；')}` : ''
  const sys =
    `你是商业财务分析师。基于产品、其范式「${paradigm}」与定价方案，给出 ROI 与预期收入评估的**可计算假设**（不要长篇大论，给数字）。\n` +
    'currency：货币单位(如 "元")；horizonMonths：评估期月数(通常 12)；\n' +
    'scenarios：三个情景(name 用 保守/中性/乐观)，每个给：users(评估期内可获取的用户数)、payRate(付费转化率 %)、' +
    'arpuMonthly(付费用户人均月付费)、grossMargin(毛利率 %)、cac(每付费用户获客成本)、fixedCostMonthly(月固定成本)；' +
    '数字要符合该产品规模与范式常识，三情景由低到高递增；\n' +
    'assumptionNotes：这些数字的依据与口径说明；drivers：对结果最敏感的驱动因素；risks：预估风险。中文，数字务实。'
  const msg = `名称：${p.name || ''}\n定位：${p.positioning || ''}\n人群：${p.audience || ''}\n功能：${p.features || ''}${monText}`
  try {
    const text = await completeText({ ...req.body, system: sys, messages: [{ role: 'user', content: msg }], format: ROI_SCHEMA, effort: 'medium', max_tokens: 2500 })
    res.json(parseModelJson(text))
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }) }
})

const server = app.listen(PORT, () => console.log(`[server] proxy listening on http://localhost:${PORT}`))
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\n[FATAL] 端口 ${PORT} 已被占用 —— 很可能有一个旧的后端仍在运行（它不含最新的 /api 路由，` +
        `会导致前端收到 HTML、报 "Unexpected token '<'"）。\n` +
        `  请先结束旧进程，再重启：\n    lsof -ti tcp:${PORT} | xargs kill -9\n`
    )
    process.exit(1)
  }
  throw e
})

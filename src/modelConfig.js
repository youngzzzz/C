// 模型配置：存在 localStorage，全站生效。支持 Claude 与 DeepSeek。
const KEY = 'llm_model_config_v1'

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    baseURLPlaceholder: '默认 https://api.anthropic.com',
    keyHint: '留空则用服务端 ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-opus-4-8', name: 'Opus 4.8 · 最强' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6 · 均衡' },
      { id: 'claude-haiku-4-5', name: 'Haiku 4.5 · 最快' },
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    baseURLPlaceholder: '默认 https://api.deepseek.com',
    keyHint: '在 platform.deepseek.com 获取，留空则用服务端 DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash · 快/省' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro · 最强' },
    ],
  },
}

const DEFAULT = { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: '', baseURL: '' }

export function getConfig() {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...DEFAULT }
  }
}

export function setConfig(c) {
  localStorage.setItem(KEY, JSON.stringify(c))
}

// Merge the active config into an outgoing request body.
// An explicit body.provider/model (e.g. the router) wins; the key/baseURL are only
// attached when the call's provider matches the configured provider.
export function withConfig(body = {}) {
  const c = getConfig()
  const provider = body.provider || c.provider
  const model = body.model || c.model
  const out = { ...body, provider, model }
  if (provider === c.provider) {
    if (c.apiKey) out.apiKey = c.apiKey
    if (c.baseURL) out.baseURL = c.baseURL
  }
  return out
}

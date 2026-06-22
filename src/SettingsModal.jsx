import { useState } from 'react'
import { PROVIDERS, getConfig, setConfig } from './modelConfig.js'
import { complete } from './api.js'

export default function SettingsModal({ onClose }) {
  const [cfg, setCfg] = useState(getConfig())
  const [test, setTest] = useState(null) // {ok, msg}
  const [testing, setTesting] = useState(false)

  const prov = PROVIDERS[cfg.provider]
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }))

  const onProvider = (provider) => {
    const first = PROVIDERS[provider].models[0].id
    set({ provider, model: first })
    setTest(null)
  }

  const save = () => {
    setConfig(cfg)
    onClose()
  }

  const runTest = async () => {
    setConfig(cfg) // persist so the test uses current values
    setTesting(true)
    setTest(null)
    try {
      const t = await complete({
        messages: [{ role: 'user', content: '只回复两个字：在线' }],
        max_tokens: 16,
        effort: 'low',
      })
      setTest({ ok: true, msg: `连接成功 · 返回「${(t || '').trim().slice(0, 20)}」` })
    } catch (e) {
      setTest({ ok: false, msg: e.message || String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>⚙️ 模型设置</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <p className="modal-sub">选择服务商与模型。可填入自己的 API Key（存在浏览器本地，仅发往本项目的服务端代理）。</p>

        <label className="cfg-label">服务商</label>
        <div className="provider-seg">
          {Object.entries(PROVIDERS).map(([id, p]) => (
            <button key={id} className={cfg.provider === id ? 'on' : ''} onClick={() => onProvider(id)}>
              {p.label}
            </button>
          ))}
        </div>

        <label className="cfg-label">模型</label>
        <select className="cfg-input" value={cfg.model} onChange={(e) => set({ model: e.target.value })}>
          {prov.models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>

        <label className="cfg-label">API Key（可选）</label>
        <input
          className="cfg-input"
          type="password"
          value={cfg.apiKey}
          placeholder={prov.keyHint}
          onChange={(e) => set({ apiKey: e.target.value })}
        />

        <label className="cfg-label">Base URL（可选）</label>
        <input
          className="cfg-input"
          value={cfg.baseURL}
          placeholder={prov.baseURLPlaceholder}
          onChange={(e) => set({ baseURL: e.target.value })}
        />

        {cfg.provider === 'deepseek' && (
          <div className="cfg-note">
            DeepSeek 走 OpenAI 兼容协议；<strong>答案引擎/竞品研究</strong>的联网检索会自动改走
            DeepSeek 的 Anthropic 端点调用其原生 web_search，无需额外配置。检索不可用时降级为模型内置知识。
          </div>
        )}

        {test && <div className={`test-result ${test.ok ? 'ok' : 'bad'}`}>{test.ok ? '✓ ' : '✕ '}{test.msg}</div>}

        <div className="modal-actions">
          <button className="ghost" onClick={runTest} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  )
}

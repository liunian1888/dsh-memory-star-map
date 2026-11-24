// dsh-memory-star-map 宿主半（Node / Cordis 插件）
// 第③阶段：星图数据 JSON 读写 + 会话自动提炼（读 ~/.dsh/sessions 的 zstd 会话日志，
// 用 DSH 的 llm 服务摘要成候选记忆星，交给客户端「待认领区」由用户点亮）。
// 注意：webServer 的 WebResourceRoute 只响应 GET（POST 会被框架层 405），
// 因此这里统一用 WebRoute 的 handler(req,res) 风格手动处理所有 method。
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-memory-star-map'
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const DATA_DIR = join(homedir(), '.dsh', 'storages', 'dsh-memory-star-map')
const DATA_FILE = join(DATA_DIR, 'stars.json')
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
// 敏感词：含这些词的用户消息不进提炼摘要（需求⑥：默认不扫含敏感词内容）
const SENSITIVE = [/password/i, /密码/, /\btoken\b/i, /secret/i, /密钥/, /api[-_ ]?key/i]

// 二十八宿 = 28 个技艺大类（客户端可改名，随 stars.json 的 mansions 字段持久化）
const DEFAULT_MANSIONS = [
  ['青龙', '角'], ['青龙', '亢'], ['青龙', '氐'], ['青龙', '房'], ['青龙', '心'], ['青龙', '尾'], ['青龙', '箕'],
  ['朱雀', '井'], ['朱雀', '鬼'], ['朱雀', '柳'], ['朱雀', '星'], ['朱雀', '张'], ['朱雀', '翼'], ['朱雀', '轸'],
  ['白虎', '奎'], ['白虎', '娄'], ['白虎', '胃'], ['白虎', '昴'], ['白虎', '毕'], ['白虎', '觜'], ['白虎', '参'],
  ['玄武', '斗'], ['玄武', '牛'], ['玄武', '女'], ['玄武', '虚'], ['玄武', '危'], ['玄武', '室'], ['玄武', '壁'],
]
function defaultMansions() {
  return DEFAULT_MANSIONS.map(([g, n]) => ({ name: n, group: g, desc: '' }))
}
function sanitizeMansions(list) {
  const def = defaultMansions()
  if (!Array.isArray(list)) return def
  return def.map((d, i) => {
    const it = list[i]
    if (!it || typeof it !== 'object') return d
    const name = String(it.name != null ? it.name : '').trim().slice(0, 24)
    return { name: name || d.name, group: d.group, desc: String(it.desc || '').slice(0, 120) }
  })
}

// ---------- HTTP 辅助（Node IncomingMessage / ServerResponse） ----------
const MAX_BODY_BYTES = 10 * 1024 * 1024
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (finish) => { if (settled) return; settled = true; finish() }
    const onData = (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { settle(() => reject(Object.assign(new Error('body too large'), { code: 'body-too-large' }))); req.destroy(); return }
      chunks.push(chunk)
    }
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString('utf8')))
    const onError = (e) => settle(() => reject(e))
    const onAborted = () => settle(() => reject(Object.assign(new Error('aborted'), { code: 'client-aborted' })))
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('close', onAborted); req.on('aborted', onAborted)
  })
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8')
    const data = JSON.parse(raw)
    return { stars: Array.isArray(data.stars) ? data.stars : [], mansions: sanitizeMansions(data.mansions) }
  } catch {
    return { stars: [], mansions: defaultMansions() }
  }
}

async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return data
}

// ---------- 会话日志解码 ----------
// session.v4.jsonl.zstd = 多个 zstd 帧拼接（每帧一段 JSONL 文本）。
// Node 的 zstd 解码器只吃单帧，故按 magic 偏移切帧逐段解压再拼接。
function decodeSessionFile(file) {
  const b = readFileSync(file)
  const offs = []
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] === ZSTD_MAGIC[0] && b[i + 1] === ZSTD_MAGIC[1] && b[i + 2] === ZSTD_MAGIC[2] && b[i + 3] === ZSTD_MAGIC[3]) offs.push(i)
  }
  if (offs.length === 0) return ''
  offs.push(b.length)
  let txt = ''
  for (let i = 0; i < offs.length - 1; i++) {
    try { txt += zlib.zstdDecompressSync(b.subarray(offs[i], offs[i + 1])).toString('utf8') } catch { /* 坏帧跳过 */ }
  }
  return txt
}

function decodeFirstFrame(file) {
  const b = readFileSync(file)
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] === ZSTD_MAGIC[0] && b[i + 1] === ZSTD_MAGIC[1] && b[i + 2] === ZSTD_MAGIC[2] && b[i + 3] === ZSTD_MAGIC[3]) {
      let end = b.length
      for (let j = i + 4; j < b.length - 4; j++) {
        if (b[j] === ZSTD_MAGIC[0] && b[j + 1] === ZSTD_MAGIC[1] && b[j + 2] === ZSTD_MAGIC[2] && b[j + 3] === ZSTD_MAGIC[3]) { end = j; break }
      }
      return zlib.zstdDecompressSync(b.subarray(i, end)).toString('utf8')
    }
  }
  return ''
}

function parseSessionText(txt) {
  const out = { cwd: '', title: '', createdAt: 0, pairs: [] }
  for (const ln of txt.split('\n')) {
    if (!ln) continue
    let o
    try { o = JSON.parse(ln) } catch { continue }
    if (o.type === 'session') { out.cwd = o.cwd || ''; out.createdAt = o.createdAt || 0 }
    else if (o.type === 'session/title' && o.data && o.data.title) out.title = o.data.title
    else if (o.type === 'user/message' && o.data && Array.isArray(o.data.content)) {
      const text = o.data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
      if (text) out.pairs.push({ role: 'user', text })
    } else if (o.type === 'assistant/message' && o.data && o.data.message && Array.isArray(o.data.message.content)) {
      const text = o.data.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
      if (text) out.pairs.push({ role: 'assistant', text })
    }
  }
  return out
}

function isSensitive(text) { return SENSITIVE.some(re => re.test(text)) }
function clip(text, n) { return text.length > n ? text.slice(0, n) + '…' : text }

async function listSources() {
  const sources = []
  let wsDirs = []
  try { wsDirs = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true }) } catch { return sources }
  for (const wd of wsDirs) {
    if (!wd.isDirectory()) continue
    const wsPath = join(SESSIONS_ROOT, wd.name)
    let sesDirs = []
    try { sesDirs = await fs.readdir(wsPath, { withFileTypes: true }) } catch { continue }
    let cwd = '', title = '', lastActive = 0, count = 0
    for (const sd of sesDirs) {
      if (!sd.isDirectory()) continue
      const file = join(wsPath, sd.name, 'session.v4.jsonl.zstd')
      let st
      try { st = await fs.stat(file) } catch { continue }
      count++
      if (st.mtimeMs > lastActive) lastActive = st.mtimeMs
      if (!cwd) {
        try {
          const head = parseSessionText(decodeFirstFrame(file))
          cwd = head.cwd || cwd
          title = head.title || title
        } catch { /* ignore */ }
      }
    }
    if (count > 0) sources.push({ dirName: wd.name, cwd: cwd || '(未知)', title, sessions: count, lastActive })
  }
  sources.sort((a, b) => b.lastActive - a.lastActive)
  return sources
}

async function collectDigest(dirName, limit) {
  const wsPath = join(SESSIONS_ROOT, dirName)
  const sesDirs = await fs.readdir(wsPath, { withFileTypes: true })
  const items = []
  for (const sd of sesDirs) {
    if (!sd.isDirectory()) continue
    const file = join(wsPath, sd.name, 'session.v4.jsonl.zstd')
    let st
    try { st = await fs.stat(file) } catch { continue }
    items.push({ file, mtime: st.mtimeMs })
  }
  items.sort((a, b) => b.mtime - a.mtime)
  const digest = []
  for (const it of items.slice(0, limit)) {
    let s
    try { s = parseSessionText(decodeSessionFile(it.file)) } catch { continue }
    const lines = []
    let used = 0
    for (const p of s.pairs) {
      if (p.role === 'user' && isSensitive(p.text)) continue
      lines.push(`${p.role === 'user' ? '用户' : '助手'}: ${clip(p.text, p.role === 'user' ? 500 : 700)}`)
      used++
      if (used >= 14) break
    }
    if (lines.length === 0) continue
    digest.push({ title: s.title || '(无标题)', body: lines.join('\n') })
  }
  return digest
}

const EXTRACT_SYSTEM = `你是「记忆星图」的记忆提炼器。输入是若干段人机对话摘要，输出值得长期记住的记忆条目。
要求：
- 只提炼有长期价值的内容：决策、结论、偏好、事实、经验教训、计划；跳过寒暄与过程性废话。
- 每条记忆：title（<=18字名词短语）、content（1-3句完整陈述）、tags（1-3个中文短标签）、importance（1-5 整数，越重要越大）。
- 严格输出 JSON 数组，不要任何解释、不要代码围栏：[{"title":"","content":"","tags":[],"importance":3}]
- 没有值得记的内容时输出 []。`

async function runExtract(ctx, dirName, limit) {
  const digest = await collectDigest(dirName, limit)
  if (digest.length === 0) return { v: 3, candidates: [], note: '这些会话里没有可提炼的对话内容' }
  const { mansions } = await load()
  const catList = mansions.map((m, i) => `${i}:${m.name}`).join('、')
  const system = EXTRACT_SYSTEM
    + `\n- 星图有 28 个技艺大类（编号:名称）：${catList}`
    + '\n- 为每条记忆选择最匹配的大类，mansion 字段输出其编号（0-27 整数）；都不匹配输出 -1。'
  const prompt = digest.map((d, i) => `【会话${i + 1}｜${d.title}】\n${d.body}`).join('\n\n---\n\n')
  const sel = ctx.agentDefaultModel.currentSelection()
  const options = {
    provider: sel.provider,
    model: sel.model,
    sessionId: 'dsh-memory-star-map:extract',
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
    system,
    temperature: 0.4,
    signal: AbortSignal.timeout(180000),
  }
  const assembler = new BlockAssembler()
  let text = ''
  try {
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    text = assembler.blocks().filter(b => b.type === 'text').map(b => ('text' in b) ? b.text : '').join('').trim()
  } catch (e) {
    return { v: 3, candidates: [], error: '模型调用失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return { v: 3, candidates: [], note: '模型未返回可解析的 JSON：' + text.slice(0, 200) }
  let arr
  try { arr = JSON.parse(m[0]) } catch (e) { return { v: 3, candidates: [], note: 'JSON 解析失败：' + String((e && e.message) || e) + '（原文：' + text.slice(0, 120) + '）' } }
  if (!Array.isArray(arr)) arr = []
  const candidates = arr.filter(c => c && c.title).map((c, ci) => {
    let mi = -1
    if (typeof c.mansion === 'number' && Number.isFinite(c.mansion)) mi = Math.round(c.mansion)
    else if (typeof c.mansion === 'string' && c.mansion.trim()) {
      const t = c.mansion.trim()
      mi = mansions.findIndex(m => m.name === t)
      if (mi < 0) mi = mansions.findIndex(m => m.name.includes(t) || t.includes(m.name))
    }
    if (mi < 0 || mi >= mansions.length) mi = ci % mansions.length
    return {
      title: String(c.title).slice(0, 60),
      content: String(c.content || ''),
      tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 4) : [],
      importance: Math.max(1, Math.min(5, Number(c.importance) || 3)),
      source: 'auto',
      from: digest.map(d => d.title).slice(0, limit).join(' / '),
      mansion: mi,
    }
  })
  return { v: 3, candidates, scanned: digest.length }
}

const ROUTE_BASES = ['/api/memory-star-map', '/api/memory-star-map-2', '/api/memory-star-map-3']

export function apply(ctx) {
  // webServer 的 prefix 路由在旧实例卸载时不会释放（需重启 DSH 才释放），
  // 原地升级激活会报 duplicate prefix route。这里按顺序回退注册：
  // 主路由被旧实例占用时自动改用备用路由（client 会依次探测各 base），
  // 全部被占用则跳过注册、由 client 回落 localStorage，保证 apply 不抛错。
  let base = null
  let off = null
  const handler = async (req, res) => {
      try {
        const path = (req.url || '/').split('?')[0].replace(/\/+$/, '')
        const rel = base && path.startsWith(base) ? path.slice(base.length) : path
        const method = (req.method || 'GET').toUpperCase()
        if ((rel === '' || rel === '/') && method === 'GET') {
          const data = await load()
          return sendJson(res, 200, { v: 3, stars: data.stars, mansions: data.mansions })
        }
        if ((rel === '' || rel === '/') && method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const stars = Array.isArray(body.stars) ? body.stars : []
          const data = await save({ v: 3, stars, mansions: sanitizeMansions(body.mansions) })
          return sendJson(res, 200, { v: 3, ok: true, count: data.stars.length })
        }
        if (rel === '/sources' && method === 'GET') {
          return sendJson(res, 200, { v: 2, sources: await listSources() })
        }
        if (rel === '/extract' && method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const dirName = String(body.dirName || '')
          const limit = Math.max(1, Math.min(10, Number(body.limit) || 3))
          if (!dirName || dirName.includes('..') || dirName.includes('/') || dirName.includes('\\')) {
            return sendJson(res, 200, { v: 2, candidates: [], error: '非法的工作区名' })
          }
          return sendJson(res, 200, await runExtract(ctx, dirName, limit))
        }
        return sendJson(res, 200, { v: 2, error: 'not found' })
      } catch (e) {
        return sendJson(res, 200, { v: 2, error: '内部错误：' + String((e && e.message) || e) })
      }
  }
  for (const b of ROUTE_BASES) {
    try {
      off = ctx.webServer.register({ kind: 'prefix', path: b, handler })
      base = b
      break
    } catch {
      // 路由被旧实例占用，尝试下一个备用路由
    }
  }
  if (off) ctx.on('dispose', () => off())
}
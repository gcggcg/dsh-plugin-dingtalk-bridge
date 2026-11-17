import { readFile, writeFile, rename, mkdir, unlink, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  describeFailure,
  killTree,
  parseDeviceFlow,
  parseLooseJson,
  runDws,
  spawnDws,
  toText,
  createLineReader,
} from './dws.js'
import QRCode from 'qrcode'

import { buildSuggestPrompt, generateSuggestion, formatClock } from './suggest.js'

export const ROUTE_PREFIX = '/api/dingtalk-bridge'
/** 每次改动宿主行为就换个标记：界面与 http-debug.log 都会带上，用来确认「跑的是新代码」。 */
export const HOST_BUILD = '0.3.6-20261117T1415'

/** 私信（单聊）全部消息。 */
const O2O_KEY = 'user_im_message_receive_o2o_all'
/** 群聊中 @ 我的消息。 */
const AT_KEY = 'user_im_message_receive_at'

const MAX_SEEN = 4000
const SEEN_TTL = 10 * 60 * 1000
const HEALTH_INTERVAL = 5 * 60 * 1000
const MIN_STABLE_MS = 30 * 1000
const SUGGEST_CONCURRENCY = 2
const BODY_LIMIT = 64 * 1024

/** dws 的 npm 包名：`npm install -g dingtalk-workspace-cli` 之后就有 `dws` 命令。 */
const DWS_PACKAGE = 'dingtalk-workspace-cli'
const DWS_REGISTRY_DEFAULT = 'https://registry.npmjs.org/'
const INSTALL_TIMEOUT = 300 * 1000
const INSTALL_LOG_LIMIT = 4000

/** 拼 `npm install -g` 的参数：只在用户点「安装 dws」时才会真正执行。 */
export function buildInstallArgs({ target = '', registry = DWS_REGISTRY_DEFAULT } = {}) {
  const version = String(target ?? '').trim().replace(/^v/, '')
  const spec = version === '' ? DWS_PACKAGE : `${DWS_PACKAGE}@${version}`
  const source = String(registry ?? '').trim() || DWS_REGISTRY_DEFAULT
  return ['install', '-g', spec, '--no-fund', '--no-audit', `--registry=${source}`]
}

/** 判断命令失败是不是「根本没有这个命令」（而不是参数错、未登录之类的业务错误）。 */
export function looksLikeMissingCommand(text) {
  return /ENOENT|not recognized|不是内部或外部命令|command not found|无法将.{0,20}识别|No such file/i.test(
    String(text ?? ''),
  )
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
}

/** 时间戳归一化为毫秒：支持秒/毫秒数字与「2026-11-14 11:31:27」这类日期字符串。 */
function normalizeTimestamp(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text !== '' && !/^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = Date.parse(text.replace(' ', 'T'))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
  }
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(number) || number <= 0) return Date.now()
  return number < 1e11 ? Math.round(number * 1000) : Math.round(number)
}

const EARLIEST_PLAUSIBLE = Date.UTC(2020, 0, 1)

/**
 * 修正历史存档里的脏时间戳。
 * 早期版本用 Number.parseFloat 处理 "2026-11-14 11:31:27" 这类字符串，得到 2026 → 2026000，
 * 面板上就显示成 1970-01-24。读档时把明显不合理的值重置为「现在」，
 * 避免旧记录一直挂在 1970 年（正文与状态都保留，只修时间）。
 */
function repairStoredTime(value) {
  const repaired = normalizeTimestamp(value)
  const latest = Date.now() + 24 * 60 * 60 * 1000
  if (repaired < EARLIEST_PLAUSIBLE || repaired > latest) return Date.now()
  return repaired
}

/**
 * 早期版本发送命令缺少 --yes，dws 会以 confirmation_required 拒绝，失败结果被写进存档。
 * 这类失败是插件自身的 bug、不是消息本身的问题：读档时清掉失败标记，
 * 让卡片回到「有建议、可直接发送」的状态，避免用户看到永远不会自愈的红色报错。
 */
function healLegacyFailure(message) {
  const replyError = String(message.reply?.error ?? '')
  const legacy = /confirmation_required|需要用户确认/i.test(replyError) || /confirmation_required|需要用户确认/i.test(String(message.error ?? ''))
  if (!legacy || message.reply?.ok === true) return message
  const suggestion = message.suggestion && typeof message.suggestion.text === 'string' && message.suggestion.text !== ''
  return {
    ...message,
    reply: null,
    error: '',
    status: suggestion ? 'suggested' : 'received',
    needsHuman: false,
  }
}

function collapseWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
}

/** 从事件里提取可展示的正文。 */
export function extractEventText(event) {
  const candidate = []
  const content = event?.content

  if (typeof content === 'string') candidate.push(content)
  else if (content && typeof content === 'object') {
    candidate.push(content.text, content.content, content.title, content.markdown)
  }

  candidate.push(event?.text, event?.markdown)

  for (const item of candidate) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = parseLooseJson(trimmed)
      if (parsed && typeof parsed === 'object') {
        const nested = [parsed.text, parsed.content, parsed.title, parsed.markdown, parsed.fileName]
          .find((value) => typeof value === 'string' && value.trim() !== '')
        if (nested) return collapseWhitespace(nested)
      }
      // 解析不出 JSON 时按普通正文继续（例如 '[图片消息](mediaId=…)' 这种 markdown，
      // 曾经因为以 '[' 开头被当成 JSON 直接丢掉）。
    }
    return collapseWhitespace(trimmed)
  }

  const msgtype = String(event?.msgtype || event?.message_type || '')
  if (msgtype !== '' && !/text/i.test(msgtype)) return `[${msgtype} 消息]`
  return ''
}

/** 判定消息来源类型：私信还是群 @。 */
export function detectMessageKind(event) {
  const type = String(event?.type || event?.event_type || '').toLowerCase()
  if (type.includes('_o2o') || type.includes('direct') || type.includes('single')) return 'dm'
  if (type.includes('_at') || type.endsWith('at') || type.includes('group')) return 'group'
  const conversationType = String(event?.conversation_type ?? event?.chat_type ?? '')
  if (conversationType === '2' || conversationType.toLowerCase().includes('group')) return 'group'
  if (String(event?.conversation_title ?? '').trim() !== '') return 'group'
  return 'dm'
}

function sourceKeyOf(record) {
  return record.kind === 'group'
    ? `group:${record.conversationId || record.conversationTitle || 'unknown'}`
    : `dm:${record.senderId || record.sender || 'unknown'}`
}

/** 钉钉图片消息在正文里的标记：`[图片消息](mediaId=@xxxx)`。 */
const IMAGE_MARKER = /\[图片消息\]\s*\(\s*mediaId\s*=\s*([^\s)]+)\s*\)/gi

/**
 * 从事件正文里抽出图片 mediaId（钉钉事件不提供结构化媒体字段，
 * 只能从 content 的 markdown 标记里取，再用 dws 下载）。
 */
export function extractImageRefs(event) {
  const raw = extractEventText(event)
  const refs = []
  if (raw === '') return refs
  IMAGE_MARKER.lastIndex = 0
  let match = IMAGE_MARKER.exec(raw)
  while (match) {
    const mediaId = String(match[1] || '').trim()
    if (mediaId !== '' && !refs.some((item) => item.mediaId === mediaId)) {
      refs.push({ mediaId })
    }
    match = IMAGE_MARKER.exec(raw)
  }
  return refs
}

/** 钉钉在图片消息正文里附带的下载提示，对用户和模型都是噪音，直接丢掉。 */
const IMAGE_HINT = /注意[:：]\s*如需下载[^]*?命令下载|如需下载使用\s*dws[^\n]*?下载/gi

/** 把正文里的图片标记替换成可读占位，避免把一段 markdown 直接丢给模型。 */
export function stripImageMarkers(text) {
  return String(text ?? '')
    .replace(IMAGE_MARKER, '[图片]')
    .replace(IMAGE_HINT, ' ')
    .replace(/\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按文件头判断图片类型（dws 落盘的文件没有扩展名保证）。 */
export function sniffImageMediaType(buffer) {
  if (!buffer || buffer.length < 12) return ''
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return ''
}

/**
 * 钉钉侧的幂等键冲突：同一个 `--idempotency-key` 再提交一次会被拒，
 * 报错形如 `sendPersonalMessageByServerPush error: Request is repeated with uuid '…'`。
 * 这既可能是「上一次其实已经发出去了」，也可能是老版本插件反复用同一个键导致永远发不出去，
 * 所以 UI 要单独提示并允许换键重发。
 */
export function isDuplicateSendFailure(text) {
  const value = String(text ?? '')
  return /Request is repeated with uuid/i.test(value) || /is repeated with uuid/i.test(value) || /幂等/.test(value)
}

/**
 * 群消息回复时先 @ 对方：dws 要求正文里带 `<@openDingTalkId>` 占位符，
 * 并且用 `--at-open-dingtalk-ids` 声明要 @ 的人，钉钉会把它渲染成真正的 @提及。
 */
export function composeReplyBody({ record, text, replyPrefix = '', atSender = false }) {
  const plain = String(text ?? '')
  const prefix = String(replyPrefix ?? '')
  const mention =
    atSender && record && record.kind === 'group' && record.senderId ? `<@${String(record.senderId)}> ` : ''
  return `${mention}${prefix}${plain}`.trim()
}

/**
 * 把一次回复拆成「要依次发出的多条消息」。
 * - `multiSend` 关闭时永远只发一条（多条用换行连起来）；
 * - 自动回复优先用模型给的 `replies`，人工回复按换行拆分（空行/单换行都算分隔）；
 * - 最多 `max` 条，空串与相邻重复会被丢掉。
 */
export function planReplyParts({ text = '', replies = [], multiSend = true, max = 5 }) {
  const raw = String(text ?? '')
  if (!multiSend) return [raw.trim()].filter((item) => item !== '')
  const limit = Math.max(1, Math.min(10, Math.round(Number(max) || 5)))
  const fromModel = Array.isArray(replies)
    ? replies.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
    : []
  const candidates =
    fromModel.length > 1
      ? fromModel
      : raw
          .split(/\r?\n+/)
          .map((item) => item.trim())
          .filter((item) => item !== '')
  const parts = []
  for (const item of candidates.length > 0 ? candidates : [raw.trim()]) {
    if (item === '') continue
    if (parts.length > 0 && parts[parts.length - 1] === item) continue
    parts.push(item)
    if (parts.length >= limit) break
  }
  return parts
}

/** 组装 `dws chat +messages-send` 参数（纯函数，便于自测）。 */
export function buildSendArgs({ record, body, auto = false, dryRun = false, attempt = 0, atSender = false, partIndex = 1 }) {
  const args = ['chat', '+messages-send', '--as', 'user']
  if (record.kind === 'group') {
    args.push('--group', String(record.conversationId ?? ''))
  } else {
    args.push('--open-dingtalk-id', String(record.senderId ?? ''))
  }
  args.push('--text', String(body))
  // 群 @ 回复：明确 @ 回发送人，保证「谁 @ 我，我就 @ 谁」。
  if (atSender && record.kind === 'group' && record.senderId) {
    args.push('--at-open-dingtalk-ids', String(record.senderId))
  }
  // 幂等键：同一事件的第一发用固定键（重复提交时钉钉会去重，避免连点发出两条）；
  // 之后每次重试都换一个新键（-r2/-r3…），否则钉钉会一直报
  // 「Request is repeated with uuid ...」，导致重发永远发不出去。
  // 连续发多条时每条再带 -p2/-p3…，否则第二条会被当成重复消息直接丢掉。
  const baseKey = `dsh-dingtalk-${String(record.id ?? '')}`
  const tries = Math.max(0, Number(attempt) || 0)
  const part = Math.max(1, Number(partIndex) || 1)
  const key = `${baseKey}${part > 1 ? `-p${part}` : ''}${tries === 0 ? '' : `-r${tries + 1}`}`
  args.push('--idempotency-key', key)
  // 人工确认过的回复按本人身份发送；全自动回复保留 AI 角标。
  if (!auto) args.push('--ai-tag=false')
  if (record.profile) args.push('--profile', String(record.profile))
  // dws 在非交互环境要求显式确认，否则会以 confirmation_required 失败。
  if (dryRun) {
    args.push('--dry-run')
  } else {
    args.push('--yes')
  }
  return args
}

export class DingTalkBridgeService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = {
      enabled: asBool(config.enabled, true),
      dwsPath: asString(config.dwsPath, 'dws').trim() || 'dws',
      dwsRegistry: asString(config.dwsRegistry, DWS_REGISTRY_DEFAULT).trim() || DWS_REGISTRY_DEFAULT,
      profiles: asStringArray(config.profiles),
      listenDirect: asBool(config.listenDirect, true),
      listenGroupAt: asBool(config.listenGroupAt, true),
      autoReply: asBool(config.autoReply, false),
      autoSuggest: asBool(config.autoSuggest, true),
      minConfidence: asNumber(config.minConfidence, 0.72, 0, 1),
      contextMessages: Math.round(asNumber(config.contextMessages, 6, 1, 12)),
    // 每个消息来源（私信按发送人、群 @ 按群）各自维护的滑动窗口长度。
    windowMessages: Math.round(asNumber(config.windowMessages, 5, 2, 20)),
      remoteContext: asBool(config.remoteContext, true),
      remoteContextLimit: Math.round(asNumber(config.remoteContextLimit, 10, 0, 30)),
      imageRecognition: asBool(config.imageRecognition, true),
      imageMax: Math.round(asNumber(config.imageMax, 2, 1, 4)),
      replyPrefix: asString(config.replyPrefix, ''),
      // 群消息回复时先在正文 @ 回发送人（dws --at-open-dingtalk-ids + <@id> 占位符）。
      groupReplyAt: asBool(config.groupReplyAt, true),
      // 连续多条：模型可把回复拆成若干条依次发出（「给我发 10 条消息试试」这种需求）。
      multiSend: asBool(config.multiSend, true),
      multiSendMax: Math.round(asNumber(config.multiSendMax, 5, 1, 10)),
      multiSendDelayMs: Math.round(asNumber(config.multiSendDelayMs, 600, 100, 5000)),
      notifyModal: asBool(config.notifyModal, true),
      maxInbox: Math.round(asNumber(config.maxInbox, 120, 20, 500)),
      suggestProvider: asString(config.suggestProvider, '').trim(),
      suggestModel: asString(config.suggestModel, '').trim(),
      suggestReasoningEffort: asString(config.suggestReasoningEffort, '').trim(),
      suggestTimeoutMs: Math.round(asNumber(config.suggestTimeoutMs, 30000, 5000, 180000)),
      dryRun: asBool(config.dryRun, false),
      // loopback = 本机浏览器授权（无需授权码）；device = 设备流（授权码 + 二维码）。
      loginMode: config.loginMode === 'device' ? 'device' : 'loopback',
      // 重新授权前先退出已登录组织，避免越授权越多组织（默认开启）。
      loginReset: asBool(config.loginReset, true),
    }

    this.statePath = join(
      process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'),
      'integrations',
      'dingtalk-bridge',
      'state.json',
    )

    this.state = {
      autoReply: this.config.autoReply,
      autoReplyTouched: false,
      // 本次开启自动回复的时刻（毫秒）。早于它到达的消息不自动发送。
      autoReplyAt: this.config.autoReply ? Date.now() : 0,
      messages: [],
      selfName: '',
      currentProfile: '',
      profiles: [],
    }

    this.tool = { ok: false, version: '', error: '', checkedAt: 0 }
    // dws 的安装/更新状态：只有用户点「安装 dws」「更新 dws」才会真的执行 npm 命令。
    this.install = {
      status: 'unknown',
      currentVersion: '',
      latestVersion: '',
      updateAvailable: false,
      targetVersion: '',
      source: '',
      log: '',
      latestError: '',
      checkedAt: 0,
    }
    this.installPromise = null
    this.login = { status: 'idle', code: '', url: '', qr: '', startedAt: 0, error: '', message: '' }
    this.loginChild = null
    this.listeners = new Map()
    this.sseClients = new Set()
    this.seen = new Map()
    this.titleCache = new Map()
    this.remoteCache = new Map()
    // 每个来源（sourceKey）一条独立的滑动窗口，AI 回复只看自己窗口里的最近若干条。
    this.windows = new Map()
    // null = 未知，true/false = 当前模型是否支持图片输入（仅用于界面提示）。
    this.vision = null
    this.timers = new Set()
    this.restartTimers = new Map()
    this.suggestQueue = []
    this.suggestBusy = 0
    this.saveChain = Promise.resolve()
    this.started = false
    this.stopped = false
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.started = true
    this.stopped = false

    if (this.config.enabled) {
      this.bootstrap().catch(() => {
        // bootstrap 内部已广播错误状态，这里只兜住未捕获异常。
      })
    }

    this.setInterval(() => this.healthCheck(), HEALTH_INTERVAL)
    this.setInterval(() => this.pruneSeen(), 60 * 1000)

    return async () => {
      this.stopped = true
      this.started = false
      for (const timer of this.timers) clearInterval(timer)
      this.timers.clear()
      for (const timer of this.restartTimers.values()) clearTimeout(timer)
      this.restartTimers.clear()
      await this.stopAllListeners()
      if (this.loginChild) {
        killTree(this.loginChild)
        this.loginChild = null
      }
      for (const res of this.sseClients) {
        try {
          res.end()
        } catch {
          // 忽略。
        }
      }
      this.sseClients.clear()
    }
  }

  setInterval(fn, ms) {
    const timer = setInterval(() => {
      if (this.stopped) return
      try {
        fn()
      } catch {
        // 定时任务异常不打断宿主。
      }
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    return timer
  }

  async bootstrap() {
    // 调试日志别无限长：超过 ~400KB 就在启动时清空。
    try {
      const logPath = join(this.dataDir(), 'http-debug.log')
      const text = await readFile(logPath, 'utf8')
      if (text.length > 400000) await writeFile(logPath, '', 'utf8')
    } catch {
      // 文件还不存在，忽略。
    }
    this.noteRequest('BOOT', ROUTE_PREFIX, 200, `${HOST_BUILD} pid=${process.pid}`)
    await this.loadState()
    this.broadcast()
    await this.checkTool()
    await this.refreshProfiles()
    if (this.state.profiles.length === 0 && this.login.status !== 'pending') {
      this.login = {
        ...this.login,
        status: 'idle',
        message: '尚未登录钉钉，请点击右上角「钉钉授权」，在弹出的授权页扫码或登录即可',
      }
    }
    this.startAllListeners()
    this.refreshVision().catch(() => {})
    // 顺手查一下 npm 上的最新版本（只查不装），让「更新 dws」按钮能显示目标版本。
    this.checkLatestDws().catch(() => {})
    this.broadcast()
  }

  /**
   * 探测当前模型是否支持图片输入。
   * 结果只用于界面提示：不支持时消息里的图片仍然会下载、展示，只是不交给模型分析。
   */
  async refreshVision() {
    const selection = this.modelInfo()
    const llm = this.ctx?.get?.('llm')
    if (selection.provider === '' || !llm || typeof llm.resolveModelInfo !== 'function') return
    try {
      const info = await llm.resolveModelInfo(selection.provider, selection.model)
      const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null
      const next = modalities === null ? null : modalities.includes('image')
      if (next !== this.vision) {
        this.vision = next
        this.broadcast()
      }
    } catch {
      if (this.vision !== null) {
        this.vision = null
        this.broadcast()
      }
    }
  }

  // ------------------------------------------------------------------- 外部命令

  /** 安装/更新 dws 时使用的 npm 源。 */
  registry() {
    return String(this.config.dwsRegistry ?? '').trim() || DWS_REGISTRY_DEFAULT
  }

  setInstall(patch) {
    this.install = { ...this.install, ...patch, checkedAt: Date.now() }
    this.broadcast()
    return this.install
  }

  /**
   * 查 npm 上 dingtalk-workspace-cli 的最新版本（只查不装）。
   * 换源时也走这里，所以界面上「检查更新」按钮可以随时点。
   */
  async checkLatestDws() {
    const base = this.registry().replace(/\/+$/, '')
    const url = `${base}/${DWS_PACKAGE}/latest`
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const version = String(data?.version ?? '').trim()
      if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('返回里没有版本号')
      const current = this.install.currentVersion || this.tool.version || ''
      return this.setInstall({
        latestVersion: version,
        latestError: '',
        updateAvailable: Boolean(current && version !== current && this.tool.ok),
      })
    } catch (error) {
      this.setInstall({ latestError: String(error?.message || error) })
      return this.install
    }
  }

  /** 依次尝试 npm_execpath、node 同目录的 npm、PATH 里的 npm。 */
  async findNpm() {
    const candidates = []
    const execPath = String(process.env.npm_execpath ?? '').trim()
    if (execPath !== '' && !/\.(?:c|m)?js$/i.test(execPath)) candidates.push(execPath)
    const nodeDir = dirname(process.execPath)
    if (process.platform === 'win32') {
      candidates.push(join(nodeDir, 'npm.cmd'))
    } else {
      candidates.push(join(nodeDir, 'bin', 'npm'), join(nodeDir, 'npm'))
    }
    candidates.push('npm')
    for (const candidate of candidates) {
      const probe = await runDws(candidate, ['--version'], { timeoutMs: 15_000 })
      if (probe.code === 0 && /\d+\.\d+\.\d+/.test(`${probe.stdout}${probe.stderr}`)) {
        return candidate
      }
    }
    return ''
  }

  /** `npm root -g`：全局 node_modules，用来找安装后的包目录。 */
  async npmGlobalRoot(npm) {
    const result = await runDws(npm, ['root', '-g'], { timeoutMs: 20_000 })
    const text = `${result.stdout}`.trim().split(/\r?\n/).filter((line) => line.trim() !== '')
    return result.code === 0 ? String(text.at(-1) ?? '').trim() : ''
  }

  /** 用户点「安装 dws」/「更新 dws」才会走到这里。 */
  async installDws(target = '') {
    if (this.installPromise) return this.installPromise
    this.installPromise = this.runInstallDws(String(target ?? '').trim()).finally(() => {
      this.installPromise = null
    })
    return this.installPromise
  }

  async runInstallDws(target) {
    const registry = this.registry()
    const npm = await this.findNpm()
    if (npm === '') {
      this.setInstall({
        status: 'error',
        source: registry,
        targetVersion: target,
        log: '没有找到 npm，无法自动安装 dws。请先安装 Node.js（自带 npm），或在配置项 dwsPath 里填一个已存在的 dws 路径。',
      })
      return { ok: false, error: 'npm not found' }
    }

    this.setInstall({
      status: 'installing',
      source: registry,
      targetVersion: target,
      log: `正在执行：${npm} ${buildInstallArgs({ target, registry }).join(' ')}`,
    })

    const args = buildInstallArgs({ target, registry })
    const result = await runDws(npm, args, { timeoutMs: INSTALL_TIMEOUT })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.code !== 0) {
      this.setInstall({
        status: 'error',
        log: output.slice(-INSTALL_LOG_LIMIT) || describeFailure(result),
      })
      return { ok: false, error: describeFailure(result) }
    }

    const root = await this.npmGlobalRoot(npm)
    const pkgDir = join(root || join(dirname(process.execPath), 'node_modules'), DWS_PACKAGE)
    // npm 12 默认会拦掉依赖的 postinstall（钉钉包靠 install.js 准备可执行文件），
    // 所以这里手动补跑一次 install.js，否则装完可能仍然找不到可用的 dws。
    let postinstallLog = ''
    const postinstall = join(pkgDir, 'install.js')
    try {
      await readFile(postinstall)
      const prepared = await runDws(process.execPath, [postinstall], {
        cwd: pkgDir,
        timeoutMs: 180_000,
        env: { ...process.env, DWS_NO_SKILLS: '1' },
      })
      postinstallLog = `${prepared.stdout}\n${prepared.stderr}`.trim().slice(-1200)
      if (prepared.code !== 0) postinstallLog = `install.js 退出码 ${prepared.code}\n${postinstallLog}`
    } catch {
      // 没有 install.js 说明这个版本不需要准备步骤。
    }

    // 有的版本把真正的可执行文件放在 vendor/ 下，优先用它（避免 cmd 垫片再绕一层）。
    const vendor = join(pkgDir, 'vendor', process.platform === 'win32' ? 'dws.exe' : 'dws')
    const installed = await runDws(vendor, ['--version'], { timeoutMs: 20_000 })
    if (installed.code === 0) this.config.dwsPath = vendor

    await this.checkTool()
    if (!this.tool.ok) {
      this.setInstall({
        status: 'error',
        log: `${output.slice(-INSTALL_LOG_LIMIT)}\n\n${postinstallLog}\n\n安装完成但 dws 仍不可用：${this.tool.error}`.trim(),
      })
      return { ok: false, error: this.tool.error }
    }

    this.setInstall({
      status: 'ready',
      currentVersion: this.tool.version,
      latestVersion: target.replace(/^v/, '') || this.install.latestVersion,
      updateAvailable: false,
      log: `已安装 dws v${this.tool.version}（来源：${registry}）`,
    })
    await this.refreshProfiles()
    this.startAllListeners()
    return { ok: true, version: this.tool.version }
  }

  /** 「更新 dws」：先查最新版，再按版本号安装。 */
  async updateDws() {
    const latest = await this.checkLatestDws()
    const target = String(latest?.latestVersion ?? '').trim()
    if (target === '') {
      return { ok: false, error: latest?.latestError || '查询最新版本失败，请检查网络或 npm 源' }
    }
    return this.installDws(target)
  }

  async checkTool() {
    const result = await runDws(this.config.dwsPath, ['--version'], { timeoutMs: 15000 })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    const version = /(\d+\.\d+\.\d+)/.exec(output)?.[1] || ''
    this.tool = {
      ok: result.code === 0 && version !== '',
      version,
      error: result.code === 0 ? '' : describeFailure(result),
      checkedAt: Date.now(),
    }
    const missing = !this.tool.ok && looksLikeMissingCommand(output)
    const current = version || this.install.currentVersion || ''
    this.install = {
      ...this.install,
      status: this.tool.ok ? 'ready' : missing ? 'missing' : 'error',
      currentVersion: current,
      updateAvailable: Boolean(
        this.tool.ok && current && this.install.latestVersion && this.install.latestVersion !== current,
      ),
      log: this.tool.ok
        ? this.install.log
        : missing
          ? `未检测到 dws 命令（当前配置：${this.config.dwsPath}）。点击「安装 dws」会自动执行 npm install -g ${DWS_PACKAGE}（来源：${this.registry()}）。`
          : this.tool.error,
      checkedAt: Date.now(),
    }
    return this.tool
  }

  async refreshProfiles() {
    const result = await runDws(this.config.dwsPath, ['profile', 'list', '-f', 'json'], { timeoutMs: 20000 })
    const payload = parseLooseJson(result.stdout)
    const raw = Array.isArray(payload?.profiles) ? payload.profiles : []
    const profiles = raw
      .map((item) => ({
        profile: String(item?.profile ?? ''),
        corpId: String(item?.corpId ?? ''),
        corpName: String(item?.corpName ?? ''),
        userId: String(item?.userId ?? ''),
        userName: String(item?.userName ?? ''),
        status: String(item?.status ?? ''),
      }))
      .filter((item) => item.profile !== '')

    this.state.profiles = profiles
    this.state.currentProfile = String(payload?.currentProfile ?? '')
    const current = profiles.find((item) => item.profile === this.state.currentProfile)
    this.state.selfName = current?.userName || this.state.selfName || ''

    if (profiles.length === 0) {
      this.tool = {
        ok: false,
        version: this.tool.version,
        error: result.code === 0 ? '未找到已登录的钉钉组织，请点击右上角「钉钉授权」登录' : describeFailure(result),
        checkedAt: Date.now(),
      }
    } else if (!this.tool.ok) {
      // 重新授权成功后要把「dws 未就绪」的旧结论翻回来，否则面板一直显示错误态。
      this.tool = { ok: true, version: this.tool.version, error: '', checkedAt: Date.now() }
    }

    return profiles
  }

  /** 需要监听的组织 profile 列表。登录态过期的组织不再监听（否则监听进程会反复报鉴权失败）。 */
  targetProfiles() {
    if (this.config.profiles.length > 0) return this.config.profiles
    const usable = this.state.profiles.filter((item) => item && (item.status === '' || item.status === 'active'))
    const current = this.state.currentProfile
    if (current !== '' && (usable.length === 0 || usable.some((item) => item.profile === current))) return [current]
    const names = usable.map((item) => item.profile).filter((name) => name !== '')
    if (names.length > 0) return names
    return current !== '' ? [current] : []
  }

  /** 判断记录里的 profile 是否仍然有效：失效时发送命令不再带 --profile，交给 dws 用当前账号。 */
  knownProfile(name) {
    const value = typeof name === 'string' ? name : ''
    if (value === '') return ''
    if (this.state.currentProfile === value) return value
    if (this.state.profiles.some((item) => item && item.profile === value)) return value
    return ''
  }

  // ------------------------------------------------------------------ 授权登录

  /** 当前是否有可用登录态（组织列表里有 active 或至少一个 profile）。 */
  hasLogin() {
    if (this.state.currentProfile !== '') return true
    return this.state.profiles.some((item) => item && item.profile !== '')
  }

  /** 已登录但登录态过期的组织，界面上提示「建议重新授权」。 */
  expiredProfiles() {
    return this.state.profiles.filter((item) => item && item.status !== '' && item.status !== 'active')
  }

  /**
   * 退出钉钉登录：先停掉所有事件监听（避免退出后监听进程反复报鉴权失败），
   * 再执行 `dws auth logout --yes`（默认退出全部账号），最后清空本地组织缓存。
   */
  async logoutAll({ quiet = false } = {}) {
    if (!quiet) {
      this.login = { ...this.login, status: 'idle', message: '正在退出钉钉登录…', error: '' }
      this.broadcast()
    }

    await this.stopAllListeners()

    let result = { code: 0, stdout: '', stderr: '' }
    try {
      result = await runDws(this.config.dwsPath, ['auth', 'logout', '--yes'], { timeoutMs: 40000 })
    } catch (error) {
      result = { code: -1, stdout: '', stderr: String(error?.message || error) }
    }

    const ok = result.code === 0
    this.state.profiles = []
    this.state.currentProfile = ''
    this.state.selfName = ''
    this.tool = {
      ok: false,
      version: this.tool.version,
      error: ok ? '已退出钉钉登录，点击「钉钉授权」重新登录' : `退出登录未成功：${describeFailure(result)}`,
      checkedAt: Date.now(),
    }

    if (!quiet) {
      this.login = {
        ...this.login,
        status: 'idle',
        code: '',
        url: '',
        qr: '',
        qrUrl: '',
        error: ok ? '' : describeFailure(result),
        message: ok ? '已退出钉钉登录，可重新点击「钉钉授权」登录新的组织' : '退出登录未成功，请稍后重试',
      }
      this.broadcast()
    }

    await this.saveState()
    return { ok, output: `${result.stdout}\n${result.stderr}`.trim() }
  }

  /**
   * 启动钉钉授权。
   *
   * 默认走 loopback（`dws auth login --no-browser`）：dws 起一个 127.0.0.1 回调，
   * 我们只需要把授权页链接交给界面打开，用户在页面里扫码/登录，回调写回 token 即完成，
   * **全程不需要抄授权码**。远程/无浏览器环境可配置 loginMode=device 走设备流
   * （--device，输出授权码 + 二维码链接）。
   */
  async startLogin() {
    if (this.loginChild) return { ok: true, login: this.login }

    // 默认先退出已登录的组织：否则每授权一次就多一个组织，监听列表越滚越长。
    if (this.config.loginReset && this.config.profiles.length === 0 && this.hasLogin()) {
      this.login = {
        ...this.login,
        status: 'idle',
        code: '',
        url: '',
        qr: '',
        qrUrl: '',
        error: '',
        message: '正在退出已登录的钉钉组织，随后申请新的授权…',
      }
      this.broadcast()
      await this.logoutAll({ quiet: true })
    }

    const mode = this.config.loginMode === 'device' ? 'device' : 'loopback'
    const args =
      mode === 'device'
        ? ['auth', 'login', '--device', '--no-browser']
        : ['auth', 'login', '--no-browser', '--yes']

    this.login = {
      status: 'pending',
      mode,
      code: '',
      url: '',
      qr: '',
      startedAt: Date.now(),
      error: '',
      message:
        mode === 'device' ? '正在向钉钉申请设备授权…' : '正在向钉钉申请授权链接…',
    }
    this.broadcast()

    let child
    try {
      child = spawnDws(this.config.dwsPath, args, {
        cwd: this.workdir(),
      })
    } catch (error) {
      this.login = {
        ...this.login,
        status: 'failed',
        error: String(error?.message || error),
        message: '无法启动 dws 授权命令',
      }
      this.broadcast()
      return { ok: false, error: this.login.error, login: this.login }
    }

    this.loginChild = child
    const reader = createLineReader((line) => this.handleLoginLine(line))
    child.stdout?.on('data', (chunk) => reader.push(toText(chunk)))
    child.stderr?.on('data', (chunk) => reader.push(toText(chunk)))
    child.on('error', (error) => {
      this.loginChild = null
      this.login = { ...this.login, status: 'failed', error: String(error?.message || error), message: '' }
      this.broadcast()
    })
    child.on('close', (code) => {
      reader.flush()
      this.loginChild = null
      if (this.login.status === 'pending') {
        this.login =
          code === 0
            ? { ...this.login, status: 'authorized', message: '授权成功，正在刷新账号与监听…' }
            : {
                ...this.login,
                status: 'failed',
                error: this.login.error || `授权未完成（退出码 ${code}）`,
                message:
                  this.login.mode === 'device'
                    ? '扫码/授权码流程已结束，但未获取到有效登录态，请重试'
                    : '本机浏览器授权没有完成（浏览器没打开或回调端口被拦截）。可以再点一次「钉钉授权」，或把配置项 loginMode 改成 device 用二维码授权。',
              }
      }
      this.broadcast()
      if (this.login.status === 'authorized') {
        // 重新授权 = 换环境。清空旧组织的收件箱，避免新组织看到一个塞满旧消息的列表。
        this.resetInbox('重新授权成功，已清空旧消息')
        this.refreshProfiles()
          .then(() => {
            this.startAllListeners()
            this.login = { ...this.login, message: '授权成功，已开始接收消息' }
            this.broadcast()
          })
          .catch(() => {})
      }
    })

    return { ok: true, login: this.login }
  }

  handleLoginLine(line) {
    const text = String(line || '')
    if (text.trim() === '') return
    const flow = parseDeviceFlow(text)
    if (flow) {
      this.login = {
        ...this.login,
        code: flow.code || this.login.code,
        url: flow.url || this.login.url,
        message:
          this.login.mode === 'device'
            ? '用钉钉扫码，或点击「打开授权页面」在浏览器里确认授权'
            : '点击「打开钉钉授权页面」，在弹出的页面里扫码或登录即可完成授权',
      }
      this.broadcast()
      // 设备流才有可扫的授权码二维码；loopback 的回调指向本机 127.0.0.1，扫二维码没意义。
      if (this.login.mode === 'device' && this.login.url !== '') this.renderLoginQr(this.login.url)
      return
    }
    if (/授权成功|登录成功|login success/i.test(text)) {
      this.login = { ...this.login, status: 'authorized', message: '授权成功' }
      this.broadcast()
      return
    }
    const failure = /授权失败|登录失败|error[:：]\s*(.+)/i.exec(text)
    if (failure) {
      this.login = { ...this.login, error: String(failure[1] || failure[0]).trim() }
      this.broadcast()
    }
  }

  /**
   * 把设备授权链接渲染成二维码（dataURL）直接放进快照，
   * 页面就不用让用户再抄一遍授权码。
   */
  renderLoginQr(url) {
    if (typeof url !== 'string' || url === '') return
    if (this.login.qrUrl === url && this.login.qr !== '') return
    QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: 'M' })
      .then((dataUrl) => {
        if (this.login.status !== 'pending') return
        this.login = { ...this.login, qr: dataUrl, qrUrl: url }
        this.broadcast()
      })
      .catch(() => {
        // 二维码生成失败不影响授权码与链接两条路径。
      })
  }

  cancelLogin() {
    if (this.loginChild) {
      killTree(this.loginChild)
      this.loginChild = null
    }
    this.login = { ...this.login, status: 'idle', message: '已取消授权', error: '', qr: '', qrUrl: '' }
    this.broadcast()
    return { ok: true, login: this.login }
  }

  // ------------------------------------------------------------------ listeners

  startAllListeners() {
    if (!this.config.enabled) return
    const keys = []
    if (this.config.listenDirect) keys.push(O2O_KEY)
    if (this.config.listenGroupAt) keys.push(AT_KEY)
    if (keys.length === 0) return

    for (const profile of this.targetProfiles()) {
      if (this.listeners.has(profile)) continue
      this.startListener(profile)
    }
  }

  startListener(profile, attempt = 0) {
    if (this.stopped) return
    if (this.listeners.has(profile)) return

    const keys = []
    if (this.config.listenDirect) keys.push(O2O_KEY)
    if (this.config.listenGroupAt) keys.push(AT_KEY)
    if (keys.length === 0) return

    const args = ['--profile', profile, 'event', 'consume', ...keys, '--flatten', '-f', 'ndjson']

    let child
    try {
      child = spawnDws(this.config.dwsPath, args, { cwd: this.workdir() })
    } catch (error) {
      this.broadcastListenerError(profile, String(error?.message || error))
      return
    }

    const entry = {
      profile,
      userName: this.state.profiles.find((item) => item.profile === profile)?.userName || this.state.selfName || '',
      child,
      status: 'connecting',
      since: Date.now(),
      readyAt: 0,
      lastEventAt: 0,
      error: '',
      attempt,
      stderrTail: '',
      buffer: '',
    }

    const reader = createLineReader((line) => this.handleLine(profile, line))

    child.stdout?.on('data', (chunk) => reader.push(toText(chunk)))
    child.stderr?.on('data', (chunk) => this.handleStderr(entry, toText(chunk)))
    child.on('error', (error) => {
      entry.error = String(error?.message || error)
      entry.status = 'error'
      this.broadcast()
    })
    child.on('close', (code) => {
      reader.flush()
      this.handleListenerClose(profile, entry, code)
    })

    this.listeners.set(profile, entry)
    this.broadcast()
  }

  handleStderr(entry, text) {
    const cleaned = String(text || '')
    if (cleaned.trim() === '') return
    entry.stderrTail = `${entry.stderrTail}${cleaned}`.slice(-2000)

    if (/\[event\]\s*ready/i.test(cleaned)) {
      entry.status = 'online'
      entry.error = ''
      entry.readyAt = Date.now()
      this.broadcast()
      return
    }

    const errorLine = cleaned
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .filter((line) => /error|失败|拒绝|denied|unauthorized|expired|invalid/i.test(line))
      .pop()

    if (errorLine) {
      entry.error = errorLine.slice(0, 500)
      if (entry.status === 'connecting') entry.status = 'error'
      this.broadcast()
    }
  }

  handleListenerClose(profile, entry, code) {
    this.listeners.delete(profile)
    if (this.stopped) return

    const stable = entry.readyAt > 0 && Date.now() - entry.readyAt > MIN_STABLE_MS
    const attempt = stable ? 1 : entry.attempt + 1
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6))

    this.broadcastListenerError(
      profile,
      entry.error || `事件监听已退出（退出码 ${code}），${Math.round(delay / 1000)} 秒后重连`,
      { retryIn: delay },
    )
    this.scheduleRestart(profile, attempt, delay)
  }

  broadcastListenerError(profile, message, extra = {}) {
    const entry = {
      profile,
      child: null,
      status: 'error',
      since: Date.now(),
      readyAt: 0,
      lastEventAt: 0,
      error: String(message || ''),
      attempt: 0,
      stderrTail: '',
      buffer: '',
      ...extra,
    }
    this.listeners.set(profile, entry)
    this.broadcast()
  }

  scheduleRestart(profile, attempt, delay) {
    const existing = this.restartTimers.get(profile)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.restartTimers.delete(profile)
      if (this.stopped || !this.config.enabled) return
      const current = this.listeners.get(profile)
      if (current && current.child) return
      this.listeners.delete(profile)
      this.startListener(profile, attempt)
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this.restartTimers.set(profile, timer)
  }

  async stopListener(profile, { graceful = true } = {}) {
    const entry = this.listeners.get(profile)
    if (!entry) return
    this.listeners.delete(profile)
    const child = entry.child
    if (!child) return

    if (graceful) {
      try {
        child.stdin?.end()
      } catch {
        // 忽略。
      }
      const closed = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2500)
        child.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      if (closed) return
    }
    killTree(child)
  }

  async stopAllListeners() {
    const profiles = [...this.listeners.keys()]
    await Promise.all(profiles.map((profile) => this.stopListener(profile)))
  }

  async restartAll() {
    await this.stopAllListeners()
    await this.refreshProfiles()
    this.startAllListeners()
    this.broadcast()
  }

  async healthCheck() {
    this.pruneSeen()
    if (!this.config.enabled || this.stopped) return

    for (const profile of this.targetProfiles()) {
      const entry = this.listeners.get(profile)
      if (!entry || entry.child === null) continue

      const result = await runDws(this.config.dwsPath, ['--profile', profile, 'event', 'status'], {
        timeoutMs: 15000,
      })
      const output = `${result.stdout}\n${result.stderr}`

      // 订阅被清空时 dws 会输出 Subscriptions: none，需要重建监听。
      if (/Subscriptions:\s*none/i.test(output)) {
        await this.stopListener(profile)
        this.scheduleRestart(profile, 1, 5000)
        this.broadcastListenerError(profile, '订阅已被清空，5 秒后重建监听')
      }
    }
  }

  pruneSeen() {
    const now = Date.now()
    for (const [key, at] of this.seen) {
      if (now - at > SEEN_TTL) this.seen.delete(key)
    }
    while (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
  }

  workdir() {
    return process.cwd()
  }

  // ------------------------------------------------------------------ 消息接入

  handleLine(profile, line) {
    const payload = parseLooseJson(line)
    if (!payload || typeof payload !== 'object') return

    const errorMessage = payload?.error?.message || payload?.error?.msg
    if (typeof errorMessage === 'string' && errorMessage.trim() !== '') {
      const entry = this.listeners.get(profile)
      if (entry) {
        entry.error = errorMessage.trim().slice(0, 500)
        const retry = normalizeTimestamp(payload?.error?.retry_after_seconds || payload?.retry_after_seconds)
        if (retry > Date.now()) {
          entry.status = 'error'
          this.broadcast()
        }
      }
      return
    }

    const entry = this.listeners.get(profile)
    if (entry) {
      entry.lastEventAt = Date.now()
      if (entry.status !== 'online') {
        entry.status = 'online'
        entry.error = ''
        this.broadcast()
      }
    }

    this.ingest(profile, payload)
  }

  ingest(profile, event) {
    const type = String(event?.type || event?.event_type || '').toLowerCase()

    // 只处理两个订阅来源的事件，其余（已读、撤回、表情回复等）一律忽略。
    const isDirect = type === O2O_KEY.toLowerCase() || type.includes('_o2o')
    const isGroupAt = type === AT_KEY.toLowerCase() || type.endsWith('_at')
    if (!isDirect && !isGroupAt) return
    if (/recall|revoke|reaction|read|remove/i.test(type)) return

    const sender = String(event?.sender ?? '').trim()
    const senderId = String(event?.sender_open_dingtalk_id ?? event?.open_dingtalk_id ?? '').trim()
    const selfName = this.listeners.get(profile)?.userName || this.state.selfName

    // 自己发送的消息会回流，忽略。
    if (sender !== '' && selfName !== '' && sender === selfName) return

    const eventId = String(event?.event_id ?? event?.message_id ?? '').trim()
    if (eventId !== '') {
      if (this.seen.has(eventId)) return
      this.seen.set(eventId, Date.now())
    }

    const kind = isGroupAt ? 'group' : detectMessageKind(event)
    if (kind === 'group' && !this.config.listenGroupAt) return
    if (kind === 'dm' && !this.config.listenDirect) return

    // 图片消息的正文只有 `[图片消息](mediaId=…)` 标记：先把 mediaId 抠出来，
    // 再把标记换成 [图片]，避免把 markdown 原文丢给模型。
    const imageRefs = this.config.imageRecognition
      ? extractImageRefs(event).slice(0, this.config.imageMax)
      : []
    const text = stripImageMarkers(extractEventText(event))
    if (text === '' && imageRefs.length === 0) return

    const conversationId = String(event?.conversation_id ?? event?.open_conversation_id ?? '').trim()
    const at = repairStoredTime(event?.create_time ?? event?.timestamp ?? event?.event_time)

    const record = {
      id: eventId !== '' ? eventId : randomUUID(),
      messageId: String(event?.message_id ?? '').trim(),
      kind,
      sender: sender !== '' ? sender : '未知联系人',
      senderId,
      text: text !== '' ? text : '[图片]',
      images: imageRefs.map((ref) => ({
        mediaId: ref.mediaId,
        file: '',
        mediaType: '',
        bytes: 0,
        state: 'pending',
      })),
      conversationId,
      conversationTitle: kind === 'group' ? this.titleCache.get(conversationId) || '' : '',
      at,
      profile,
      sourceKey: '',
      status: 'received',
      suggestion: null,
      reply: null,
      needsHuman: false,
      dismissed: false,
      error: '',
      quoted: this.extractQuoted(event),
    }
    record.sourceKey = sourceKeyOf(record)

    // 推进本来源的滑动窗口：新消息进来，最早一条被挤出去。
    this.remember(record, {
      direction: 'in',
      sender: record.sender,
      text: record.text,
      at: record.at,
      key: record.messageId || record.id,
    })

    this.state.messages.unshift(record)
    this.trimInbox()

    if (kind === 'group' && conversationId !== '') this.resolveTitle(conversationId).catch(() => {})
    this.broadcast()
    if (record.images.length > 0) this.downloadImages(record).catch(() => {})
    this.enqueueSuggestion(record)
    this.saveState().catch(() => {})
  }

  extractQuoted(event) {
    const quoted = event?.quoted_message
    if (!quoted || typeof quoted !== 'object') return ''
    const text = extractEventText(quoted)
    if (text === '') return ''
    const who = String(quoted?.sender ?? '').trim()
    return who !== '' ? `${who}：${text.slice(0, 160)}` : text.slice(0, 160)
  }

  trimInbox() {
    const limit = this.config.maxInbox
    if (this.state.messages.length > limit) {
      this.state.messages.length = limit
    }
  }

  async resolveTitle(conversationId) {
    if (this.titleCache.has(conversationId)) return this.titleCache.get(conversationId)
    this.titleCache.set(conversationId, '')

    const result = await runDws(
      this.config.dwsPath,
      ['chat', '+conversation-info', '--group', conversationId, '-f', 'json'],
      { timeoutMs: 15000 },
    )
    const payload = parseLooseJson(result.stdout)
    const title = String(
      payload?.name ?? payload?.title ?? payload?.conversationName ?? payload?.conversation?.name ?? '',
    ).trim()

    if (title === '') {
      this.titleCache.delete(conversationId)
      return ''
    }

    this.titleCache.set(conversationId, title)
    let changed = false
    for (const item of this.state.messages) {
      if (item.conversationId === conversationId && item.conversationTitle !== title) {
        item.conversationTitle = title
        item.sourceKey = sourceKeyOf(item)
        changed = true
      }
    }
    if (changed) this.broadcast()
    return title
  }

  // -------------------------------------------------------------------- 图片

  /** 图片落地目录（放在插件的状态目录下，与 state.json 同级）。 */
  /**
   * 插件数据目录（与状态文件同级），图片等二进制资源都落在这里。
   * 用它作为 dws 的工作目录：`--output` 只接受相对于工作目录的路径，
   * 而应用安装目录通常是只读的，不能作为下载落点。
   */
  dataDir() {
    return dirname(this.statePath)
  }

  mediaDir() {
    return join(this.dataDir(), 'media')
  }

  /**
   * 下载消息里的图片。钉钉事件只给 mediaId，必须用 `+messages-resource-download`
   * 才能真正拿到字节；`--output` 只接受相对工作目录的路径。
   */
  async downloadImages(record) {
    const images = Array.isArray(record?.images) ? record.images : []
    if (images.length === 0) return
    if (record.messageId === '') {
      for (const image of images) {
        image.state = 'failed'
        image.error = '缺少 message_id，无法下载图片'
      }
      this.broadcast()
      return
    }

    let dirReady = false
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]
      if (image.file !== '' && image.state === 'ready') continue
      image.state = 'downloading'

      if (!dirReady) {
        try {
          await mkdir(this.mediaDir(), { recursive: true })
          dirReady = true
        } catch {
          // 目录创建失败时让下面的下载命令自己报错。
        }
      }

      const stamp = String(record.id || randomUUID()).replace(/[^\w-]/g, '').slice(0, 24)
      const relative = `media/${stamp}-${index}.png`
      const args = [
        'chat',
        '+messages-resource-download',
        '--type',
        'mediaId',
        '--resource-id',
        image.mediaId,
        '--message-id',
        record.messageId,
        '--output',
        relative,
        '-f',
        'json',
      ]
      if (record.conversationId !== '') args.push('--open-conversation-id', record.conversationId)
      if (record.profile !== '') args.push('--profile', record.profile)

      const result = await runDws(this.config.dwsPath, args, { cwd: this.dataDir(), timeoutMs: 45000 })
      const payload = parseLooseJson(result.stdout) || parseLooseJson(result.stderr)
      const localPath = String(payload?.localPath ?? payload?.local_path ?? '').trim()
      if (result.code !== 0 || localPath === '') {
        image.state = 'failed'
        image.error = describeFailure(result).slice(0, 200)
        continue
      }

      const file = localPath.replace(/\\/g, '/')
      try {
        const bytes = await readFile(join(this.dataDir(), file))
        const mediaType = sniffImageMediaType(bytes)
        if (mediaType === '') {
          image.state = 'failed'
          image.error = '下载到的文件不是可识别的图片'
          continue
        }
        image.file = file
        image.mediaType = mediaType
        image.bytes = bytes.length
        image.state = 'ready'
      } catch (error) {
        image.state = 'failed'
        image.error = String(error?.message || error)
      }
    }

    this.broadcast()
    this.saveState().catch(() => {})
  }

  /** 读插件自带的彩色图标（icon.png），供 GET /icon 与界面复用。 */
  async readIcon() {
    if (this.iconCache && this.iconCache.length > 0) return this.iconCache
    const bytes = await readFile(new URL('../../icon.png', import.meta.url))
    this.iconCache = bytes
    return bytes
  }

  /** 读一张已下载的图片字节，供 HTTP 路由与模型输入复用。 */
  async readMedia(record, index) {
    const image = Array.isArray(record?.images) ? record.images[index] : null
    if (!image || image.state !== 'ready' || image.file === '') return null
    const bytes = await readFile(join(this.dataDir(), image.file))
    return { image, bytes, mediaType: image.mediaType || sniffImageMediaType(bytes) || 'image/png' }
  }

  /**
   * 把消息图片交给模型。
   * 只有在模型确实声明支持图片输入、且附件服务可用时才附带图片；
   * 否则返回空数组，由 prompt 里的文字说明降级处理。
   */
  async buildImageBlocks(record, selection, llm) {
    const images = Array.isArray(record?.images) ? record.images.filter((item) => item.state === 'ready') : []
    if (images.length === 0 || !selection) return { blocks: [], note: '' }

    const attachments = this.ctx?.get?.('attachments')
    if (!attachments || typeof attachments.saveImage !== 'function') {
      return { blocks: [], note: '（消息含图片，但当前环境无法读取图片内容）' }
    }

    try {
      if (llm && typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null
        if (modalities !== null && !modalities.includes('image')) {
          return { blocks: [], note: '（消息含图片，但当前模型不支持图片输入，已忽略图片内容）' }
        }
      }
    } catch {
      // 模型元数据不可用时按不支持处理，避免整次建议失败。
      return { blocks: [], note: '（消息含图片，但无法确认模型是否支持图片输入，已忽略图片内容）' }
    }

    const blocks = []
    for (let index = 0; index < images.length; index += 1) {
      try {
        const media = await this.readMedia(record, index)
        if (!media) continue
        const ref = await attachments.saveImage({
          data: media.bytes,
          mediaType: media.mediaType,
          name: `dingtalk-${record.id.slice(0, 12)}-${index}`,
        })
        blocks.push({ type: 'image', attachment: ref })
      } catch {
        // 单张失败不影响其余图片与文字建议。
      }
    }
    return { blocks, note: blocks.length > 0 ? '' : '（消息含图片，但图片读取失败）' }
  }

  // ------------------------------------------------------- 钉钉侧历史上下文

  /**
   * 从钉钉拉取该会话最新消息作为上下文。
   * 拉到的是会话真实历史，比插件本地内存里的更完整；失败时静默回退本地记录。
   */
  async remoteHistory(record) {
    if (!this.config.remoteContext || this.config.remoteContextLimit <= 0) return []
    const conversationId = String(record?.conversationId ?? '')
    if (conversationId === '') return []

    const cached = this.remoteCache.get(conversationId)
    if (cached && Date.now() - cached.at < 60 * 1000) return cached.entries

    const args = [
      'chat',
      '+chat-messages',
      '--chat-id',
      conversationId,
      '--limit',
      String(this.config.remoteContextLimit),
      '-f',
      'json',
    ]
    const result = await runDws(this.config.dwsPath, args, { timeoutMs: 20000 })
    if (result.code !== 0) return []
    const payload = parseLooseJson(result.stdout)
    const raw = payload?.data?.messages ?? payload?.messages ?? payload?.data?.items ?? payload?.items
    if (!Array.isArray(raw)) return []

    const selfName = this.state.selfName
    const entries = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const text = stripImageMarkers(String(item.text ?? item.content ?? '')).slice(0, 400)
      if (text === '') continue
      const sender = String(item.sender ?? '').trim()
      entries.push({
        direction: selfName !== '' && sender === selfName ? 'out' : 'in',
        sender: sender !== '' ? sender : '对方',
        text,
        at: normalizeTimestamp(item.createTime ?? item.create_time ?? item.timestamp),
        messageId: String(item.messageId ?? item.message_id ?? ''),
      })
    }
    entries.sort((a, b) => a.at - b.at)
    if (entries.length > 0) this.remoteCache.set(conversationId, { at: Date.now(), entries })
    return entries
  }

  // ------------------------------------------------------- 每个来源的滑动窗口

  /**
   * 消息按来源（私信=发送人，群 @=群会话）分桶，每个桶只保留最近 `windowMessages` 条。
   * 新消息进来就推进窗口、挤掉最早一条，AI 回复永远只看「本来源最近 N 条」。
   */
  windowKeyOf(record) {
    return sourceKeyOf(record)
  }

  remember(record, entry) {
    const key = this.windowKeyOf(record)
    if (key === '' || !entry) return
    const list = this.windows.get(key) || []
    const id = String(entry.key ?? '')
    if (id !== '' && list.some((item) => item.key === id)) return
    const text = String(entry.text ?? '').trim()
    if (text === '') return
    list.push({
      direction: entry.direction === 'out' ? 'out' : 'in',
      sender: String(entry.sender ?? ''),
      text: text.slice(0, 400),
      at: Number(entry.at) || Date.now(),
      key: id,
    })
    list.sort((a, b) => a.at - b.at)
    const size = this.config.windowMessages
    this.windows.set(key, list.length > size ? list.slice(-size) : list)
  }

  windowEntries(record) {
    const list = this.windows.get(this.windowKeyOf(record)) || []
    const currentId = String(record?.messageId ?? '') || String(record?.id ?? '')
    return list.filter((item) => item.at <= Number(record?.at) && item.key !== currentId && item.key !== String(record?.id ?? ''))
  }

  /** 状态文件里存下所有窗口，重启后上下文不丢。 */
  windowSnapshot() {
    const out = {}
    for (const [key, list] of this.windows) out[key] = list
    return out
  }

  restoreWindows(raw) {
    this.windows.clear()
    if (!raw || typeof raw !== 'object') return
    const size = this.config.windowMessages
    for (const [key, list] of Object.entries(raw)) {
      if (typeof key !== 'string' || key === '' || !Array.isArray(list)) continue
      const entries = list
        .filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
        .map((item) => ({
          direction: item.direction === 'out' ? 'out' : 'in',
          sender: String(item.sender ?? ''),
          text: String(item.text).slice(0, 400),
          at: Number(item.at) || Date.now(),
          key: String(item.key ?? ''),
        }))
        .sort((a, b) => a.at - b.at)
      if (entries.length === 0) continue
      this.windows.set(key, entries.slice(-size))
    }
  }

  // -------------------------------------------------------------- 建议与自动回复

  /**
   * 当前建议回复使用的模型。默认实时跟随 DSH 正在使用的大模型，
   * 只有插件配置显式指定 provider/model 时才覆盖。
   */
  modelInfo() {
    const provider = this.config.suggestProvider
    const model = this.config.suggestModel
    let fallback = null
    try {
      const service = this.ctx?.get?.('agentDefaultModel')
      const selection = service?.currentSelection?.()
      if (selection && selection.provider && selection.model) fallback = selection
    } catch {
      fallback = null
    }

    if (provider !== '' && model !== '') {
      return {
        provider,
        model,
        reasoningEffort: this.config.suggestReasoningEffort || undefined,
        source: 'config',
      }
    }
    if (provider !== '' && fallback) {
      return {
        provider,
        model: fallback.model,
        reasoningEffort: this.config.suggestReasoningEffort || fallback.reasoningEffort,
        source: 'hybrid',
      }
    }
    if (fallback) {
      const info = {
        provider: fallback.provider,
        model: fallback.model,
        reasoningEffort: this.config.suggestReasoningEffort || fallback.reasoningEffort || undefined,
        source: 'dsh',
      }
      return info
    }
    return { provider: '', model: '', reasoningEffort: undefined, source: 'none' }
  }

  resolveSelection() {
    const info = this.modelInfo()
    if (info.provider === '' || info.model === '') return null
    return { provider: info.provider, model: info.model, reasoningEffort: info.reasoningEffort }
  }

  findMessage(id) {
    return this.state.messages.find((item) => item.id === id) || null
  }

  async buildHistory(record) {
    // 窗口负责「存多少」，contextMessages 负责「喂多少」，两者取小。
    const limit = Math.max(1, Math.min(this.config.windowMessages, this.config.contextMessages))

    // 主来源：本来源自己的滑动窗口（含对方消息与我的回复，已按时间排序）。
    let entries = this.windowEntries(record).map((item) => ({ ...item }))

    // 窗口还没攒满时，用钉钉侧最新消息补齐（首次接触某个来源、或刚清空收件箱时尤其有用）。
    if (entries.length < limit) {
      const remote = await this.remoteHistory(record).catch(() => [])
      for (const item of remote) {
        if (item.at > record.at) continue
        const key = item.messageId || `remote:${item.at}`
        if (entries.some((entry) => entry.key === key)) continue
        entries.push({ direction: item.direction, sender: item.sender, text: item.text, at: item.at, key })
      }
    }

    const seen = new Set()
    entries = entries.filter((item) => {
      const key = item.key || `${item.direction}:${item.at}:${item.text.slice(0, 24)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    entries.sort((a, b) => a.at - b.at)
    return entries.slice(-limit).map(({ direction, sender, text, at }) => ({
      direction,
      sender,
      text,
      at,
    }))
  }

  /**
   * 这条消息现在还能不能由 AI 自动回复？
   * 必须同时满足：当前开着自动回复，且消息是在「本次开启」之后收到的。
   * 关闭期间积压、或关闭时正在生成建议的消息，一律不自动发送。
   */
  canAutoReply(record) {
    if (!this.state.autoReply) return false
    const enabledAt = Number(this.state.autoReplyAt) || 0
    // 老状态文件没有时间戳时按「一直开着」处理，避免升级后全部拒绝自动回复。
    if (enabledAt <= 0) return true
    return Number(record?.at) >= enabledAt
  }

  /**
   * 群消息回复要不要先 @ 发送人：谁 @ 我，我就 @ 谁。
   * 私信没有 @ 的概念；群聊需要 conversationId + 对方的 openDingTalkId。
   */
  shouldAtSender(record) {
    if (!this.config.groupReplyAt) return false
    if (!record || record.kind !== 'group') return false
    return String(record.senderId ?? '') !== '' && String(record.conversationId ?? '') !== ''
  }

  /** 关闭自动回复时，把还在排队/生成中的消息标记为「自动回复已取消」，稍后不会补发。 */  cancelPendingAutoReplies() {
    let touched = 0
    for (const record of this.state.messages) {
      if (record.reply && record.reply.ok) continue
      if (record.status === 'suggesting' || record.status === 'received' || record.status === 'sending') {
        record.autoCancelled = true
        record.needsHuman = false
        if (record.status === 'sending') record.status = 'suggested'
        touched += 1
      }
    }
    return touched
  }

  /** 清空收件箱（重新授权、手动清空都走这里），reason 用于界面提示。 */
  resetInbox(reason = '') {
    this.state.messages = []
    this.seen.clear()
    this.remoteCache.clear()
    this.windows.clear()
    this.state.inboxNotice = reason
    this.broadcast()
    this.saveState().catch(() => {})
  }

  enqueueSuggestion(record) {
    if (!this.config.autoSuggest) {
      record.status = 'received'
      return
    }
    if (!this.suggestQueue.includes(record.id)) this.suggestQueue.push(record.id)
    this.pumpSuggestQueue()
  }

  pumpSuggestQueue() {
    while (this.suggestBusy < SUGGEST_CONCURRENCY && this.suggestQueue.length > 0) {
      const id = this.suggestQueue.shift()
      const record = this.findMessage(id)
      if (!record || record.suggestion !== null) continue
      this.suggestBusy += 1
      this.refreshSuggestion(id)
        .catch(() => {})
        .finally(() => {
          this.suggestBusy -= 1
          this.pumpSuggestQueue()
        })
    }
  }

  async refreshSuggestion(id, { manual = false } = {}) {
    const record = this.findMessage(id)
    if (!record) return

    record.status = 'suggesting'
    record.error = ''
    this.broadcast()

    const llm = this.ctx?.get?.('llm')
    const selection = this.resolveSelection()

    // 图片要先落盘下载完再喂给模型；下载失败/模型不支持图片时降级为纯文本。
    const history = await this.buildHistory(record)
    const { blocks: imageBlocks, note: imageNote } = await this.buildImageBlocks(record, selection, llm)
    const prompt = buildSuggestPrompt({
      record,
      history,
      selfName: this.state.selfName || '我',
      imageNote,
      imageCount: imageBlocks.length,
      maxReplies: this.config.multiSendMax,
    })

    const result = await generateSuggestion({
      llm,
      selection,
      prompt,
      images: imageBlocks,
      timeoutMs: this.config.suggestTimeoutMs,
    })

    const current = this.findMessage(id)
    if (!current) return

    current.suggestion = {
      text: result.reply,
      // 模型给出的「多条消息」：界面上会提示将分几条发送，自动回复时按顺序依次发出。
      replies: Array.isArray(result.replies) && result.replies.length > 0 ? result.replies : [result.reply].filter(Boolean),
      confidence: result.confidence,
      needsHuman: result.needsHuman,
      reason: result.reason,
      model: result.model,
      provider: result.provider,
      ok: result.ok,
      imageCount: imageBlocks.length,
      contextCount: history.length,
      at: Date.now(),
    }

    const unclear =
      !result.ok ||
      result.reply.trim() === '' ||
      result.needsHuman ||
      result.confidence < this.config.minConfidence

    // 手动触发的「换一条建议 / 生成建议」只更新建议本身，绝不代替用户发送。
    if (manual) {
      current.status = result.ok ? 'suggested' : 'failed'
      current.needsHuman = false
      current.dismissed = false
      current.error = result.ok ? '' : result.reason
      this.broadcast()
      this.saveState().catch(() => {})
      return current
    }

    if (this.state.autoReply && this.canAutoReply(current)) {
      if (unclear) {
        current.status = 'needs-human'
        current.needsHuman = this.config.notifyModal
        current.dismissed = false
        current.error = result.ok ? '' : result.reason
      } else {
        await this.deliver(current, result.reply, {
          auto: true,
          imageCount: imageBlocks.length,
          replies: result.replies,
        })
      }
    } else {
      current.status = result.ok ? 'suggested' : 'failed'
      current.needsHuman = false
      current.error = result.ok ? '' : result.reason
      // 自动回复在生成过程中被关闭、或这条消息早于本次开启时间：只留建议，不自动发送。
      if (this.state.autoReplyTouched && result.ok && !current.autoCancelled) {
        current.autoCancelled = !this.state.autoReply || !this.canAutoReply(current)
      }
    }

    this.broadcast()
    this.saveState().catch(() => {})
  }

  /** 真正把回复发到钉钉。 */
  async deliver(record, text, { auto = false, imageCount = 0, replies = [] } = {}) {
    // 群消息回复前先 @ 发送人（可配置 groupReplyAt 关闭），私信不需要。
    const atSender = this.shouldAtSender(record)
    const body = composeReplyBody({ record, text, replyPrefix: this.config.replyPrefix, atSender })
    if (body === '') return false

    // 自动回复在「模型思考的这几秒」里可能已被用户关掉，或这条消息早于本次开启时间：
    // 发之前再判一次状态，避免关掉开关后仍然把回复发出去。
    if (auto && !this.canAutoReply(record)) {
      record.status = 'suggested'
      record.autoCancelled = true
      record.needsHuman = false
      record.reply = null
      this.broadcast()
      this.saveState().catch(() => {})
      return false
    }

    const imagesUsed = Math.max(
      imageCount,
      Array.isArray(record.images) ? record.images.filter((item) => item.state === 'ready').length : 0,
    )

    if (record.kind === 'group' && record.conversationId === '') {
      record.reply = { text: String(text ?? ''), at: Date.now(), atSender, ok: false, error: '缺少群会话 ID，无法发送', auto }
      record.status = 'failed'
      this.broadcast()
      return false
    }
    if (record.kind !== 'group' && record.senderId === '') {
      record.reply = { text: String(text ?? ''), at: Date.now(), atSender, ok: false, error: '缺少对方 openDingTalkId，无法发送', auto }
      record.status = 'failed'
      this.broadcast()
      return false
    }

    // 上一次已经撞过幂等键（旧版本固定键留下的历史记录）时，直接从 -r2 开始，
    // 免得用户点一次失败、再点一次才成功。旧记录只有 error 文本，所以两种都认。
    const burnedKey = Boolean(
      (record.reply && record.reply.duplicate) ||
        isDuplicateSendFailure(record.error) ||
        isDuplicateSendFailure(record.reply && record.reply.error),
    )
    const attempt = Math.max(0, Number(record.sendAttempts) || 0, burnedKey ? 1 : 0)
    record.sendAttempts = attempt + 1
    const parts = planReplyParts({
      text,
      replies,
      multiSend: this.config.multiSend,
      max: this.config.multiSendMax,
    })
    if (parts.length === 0) return false

    const sent = []
    let failureText = ''
    let duplicateAny = false
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const partIndex = index + 1
      // 只有第一条带 @ 提及，避免群里被连 @ 多次。
      const partAt = atSender && partIndex === 1
      const partBody = composeReplyBody({ record, text: part, replyPrefix: this.config.replyPrefix, atSender: partAt })
      if (partBody === '') continue
      const args = buildSendArgs({
        record: { ...record, profile: this.knownProfile(record.profile) },
        body: partBody,
        auto,
        dryRun: this.config.dryRun,
        attempt,
        atSender: partAt,
        partIndex,
      })
      let result = await runDws(this.config.dwsPath, args, { timeoutMs: 45000 })
      let payload = parseLooseJson(result.stdout)
      // 记录里的 profile 已被移除（例如重新授权后 profile 标识变化）时，回退到 dws 当前登录账号重试一次。
      if (result.code !== 0 && /profile\b.*not found/i.test(`${result.stderr}${result.stdout}`) && args.includes('--profile')) {
        const retryArgs = buildSendArgs({
          record: { ...record, profile: '' },
          body: partBody,
          auto,
          dryRun: this.config.dryRun,
          attempt,
          atSender: partAt,
          partIndex,
        })
        result = await runDws(this.config.dwsPath, retryArgs, { timeoutMs: 45000 })
        payload = parseLooseJson(result.stdout)
      }
      const failed =
        result.code !== 0 ||
        (payload &&
          (payload.ok === false ||
            typeof payload?.error === 'string' ||
            (payload?.error && typeof payload.error === 'object')))
      const duplicate = failed && isDuplicateSendFailure(`${result.stderr}\n${result.stdout}\n${describeFailure(result)}`)
      if (duplicate) duplicateAny = true
      sent.push({ text: part, ok: !failed, error: failed ? (duplicate ? '幂等键重复（已提交过）' : describeFailure(result)) : '' })
      if (failed) {
        failureText = duplicate
          ? '钉钉提示这条回复已经用同一个幂等键提交过（Request is repeated）。如果对方没收到，再点「发送」会自动换新的幂等键重发。'
          : describeFailure(result)
        break
      }
      // 连续发多条时留一点间隔，读起来更像人发的，也避免触发钉钉的频率限制。
      if (partIndex < parts.length) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(100, this.config.multiSendDelayMs)))
      }
    }

    const failed = failureText !== ''
    record.reply = {
      // 存纯回复正文（不含 <@id> 占位符），界面上用 atSender 标记「已 @ 对方」。
      text: sent.map((item) => item.text).join('\n'),
      parts: sent,
      partCount: parts.length,
      at: Date.now(),
      atSender,
      ok: !failed,
      error: failureText,
      auto,
      dryRun: this.config.dryRun === true,
      duplicate: duplicateAny,
      attempt: record.sendAttempts,
      matchBy: imagesUsed > 0 ? 'images' : 'text',
      imageCount: imagesUsed,
    }
    record.status = failed ? 'failed' : auto ? 'auto-replied' : 'replied'
    if (failed) record.error = record.reply.error
    else {
      record.error = ''
      record.needsHuman = false
      if (this.config.dryRun === true) record.error = '演练模式：仅预览发送内容，未真实发送'
      // 我发出去的回复也进窗口，下一轮 AI 才知道「我刚刚已经回过什么」。
      this.remember(record, {
        direction: 'out',
        sender: this.state.selfName || '我',
        text: record.reply.text,
        at: record.reply.at,
        key: `${record.id}:reply`,
      })
    }
    this.broadcast()
    this.saveState().catch(() => {})
    return !failed
  }

  // ---------------------------------------------------------------------- HTTP

  handleHttp(ctx, req, res) {
    this.dispatchHttp(ctx, req, res).catch((error) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
      } catch {
        // 响应可能已经结束。
      }
    })
  }

  async dispatchHttp(ctx, req, res) {
    const connection = ctx?.get?.('connection')
    if (!connection || typeof connection.requestRejection !== 'function') {
      this.sendJson(res, 503, { ok: false, error: 'connection service unavailable' })
      return
    }
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      const status = Number(rejection) || 403
      const detail = `rejected site=${req.headers?.['sec-fetch-site'] ?? '-'} origin=${req.headers?.origin ?? '-'} host=${req.headers?.host ?? '-'}`
      this.noteRequest(String(req.method ?? 'GET'), String(req.url ?? '/'), status, detail)
      this.sendJson(res, status, { ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    if (path === `${ROUTE_PREFIX}/state` && method === 'GET') {
      this.sendJson(res, 200, { ok: true, state: this.snapshot() })
      return
    }

    if (path === `${ROUTE_PREFIX}/events` && method === 'GET') {
      this.attachSse(res)
      return
    }

    // 插件图标：GET /icon —— 客户端侧边栏与面板头部渲染彩色图标用
    if (path === `${ROUTE_PREFIX}/icon` && method === 'GET') {
      try {
        const bytes = await this.readIcon()
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'private, max-age=86400',
        })
        res.end(bytes)
      } catch (error) {
        this.sendJson(res, 404, { ok: false, error: String(error?.message || error) })
      }
      return
    }

    // 消息图片：GET /media?id=<消息 id>&i=<序号>
    if (path === `${ROUTE_PREFIX}/media` && method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const index = Number.parseInt(url.searchParams.get('i') ?? '0', 10)
      const record = this.findMessage(id)
      if (!record) {
        this.sendJson(res, 404, { ok: false, error: 'message not found' })
        return
      }
      try {
        const media = await this.readMedia(record, Number.isFinite(index) ? index : 0)
        if (!media) {
          this.sendJson(res, 404, { ok: false, error: 'image not available' })
          return
        }
        res.writeHead(200, {
          'content-type': media.mediaType,
          'content-length': String(media.bytes.length),
          'cache-control': 'private, max-age=600',
        })
        res.end(media.bytes)
      } catch (error) {
        this.sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      }
      return
    }

    if (path === `${ROUTE_PREFIX}/action` && method === 'POST') {
      const body = await this.readBody(req)
      let payload = null
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        this.noteRequest(method, path, 400, 'invalid json body')
        this.sendJson(res, 400, { ok: false, error: 'invalid json body' })
        return
      }
      const result = await this.handleAction(ctx, payload ?? {})
      this.noteRequest(method, path, 200, String(payload?.type ?? ''))
      this.sendJson(res, 200, { ok: result.ok !== false, ...result, state: this.snapshot() })
      return
    }

    // 某些宿主/浏览器组合里 POST 会被安全护栏拦下（GET 正常），客户端会自动改用
    // 带查询参数的 GET /action... 作为兜底通道，两边执行同一套 handleAction。
    if (path === `${ROUTE_PREFIX}/action` && method === 'GET') {
      const payload = {}
      for (const [key, raw] of url.searchParams.entries()) {
        if (key === 'value') payload[key] = Number(raw)
        else if (raw === 'true') payload[key] = true
        else if (raw === 'false') payload[key] = false
        else payload[key] = raw
      }
      const result = await this.handleAction(ctx, payload)
      this.noteRequest(method, path, 200, String(payload.type ?? ''))
      this.sendJson(res, 200, { ok: result.ok !== false, ...result, state: this.snapshot() })
      return
    }

    this.sendJson(res, 404, { ok: false, error: 'not found' })
  }

  /** 记录最近若干次 API 请求，便于排查「按钮点了没反应」这类环境问题。 */
  noteRequest(method, path, status, detail = '') {
    const entry = { at: Date.now(), method, path, status, detail: String(detail).slice(0, 120) }
    if (!Array.isArray(this.requestLog)) this.requestLog = []
    this.requestLog.push(entry)
    if (this.requestLog.length > 20) this.requestLog.splice(0, this.requestLog.length - 20)
    if (status >= 400) this.lastError = `${method} ${path} → ${status}`
    const line = `${new Date(entry.at).toISOString()} ${method} ${path} ${status} ${entry.detail}\n`
    appendFile(join(this.dataDir(), 'http-debug.log'), line).catch(() => {})
  }

  async readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_LIMIT) throw new Error('request body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  sendJson(res, status, payload) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch {
      // 连接已断开。
    }
  }

  attachSse(res) {
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(`data: ${JSON.stringify(this.snapshot())}\n\n`)
    } catch {
      return
    }

    this.sseClients.add(res)
    const ping = setInterval(() => {
      if (this.stopped) return
      try {
        res.write(': ping\n\n')
      } catch {
        // 忽略。
      }
    }, 25000)
    if (typeof ping.unref === 'function') ping.unref()

    res.on('close', () => {
      clearInterval(ping)
      this.sseClients.delete(res)
    })
  }

  broadcast() {
    if (this.sseClients.size === 0) return
    const frame = `data: ${JSON.stringify(this.snapshot())}\n\n`
    for (const res of this.sseClients) {
      try {
        res.write(frame)
      } catch {
        this.sseClients.delete(res)
      }
    }
  }

  // -------------------------------------------------------------------- action

  async handleAction(ctx, payload) {
    const type = String(payload.type ?? '')

    switch (type) {
      case 'set-auto-reply': {
        const enabled = Boolean(payload.enabled)
        this.state.autoReply = enabled
        this.state.autoReplyTouched = true
        // 记录「本次开启」的时刻：只有在这之后到达的消息才允许自动回复，
        // 这样关掉再打开不会把关闭期间积压的旧消息补发出去。
        if (enabled) this.state.autoReplyAt = Date.now()
        if (!enabled) this.cancelPendingAutoReplies()
        this.broadcast()
        await this.saveState()
        return { ok: true }
      }

      case 'set-min-confidence': {
        const value = Math.round(asNumber(payload.value, this.config.minConfidence, 0.3, 1) * 100) / 100
        this.config.minConfidence = value
        this.broadcast()
        await this.saveState()
        return { ok: true }
      }

      // 上下文窗口长度：每个来源各留最近 N 条，改动立即生效并落盘。
      case 'set-window-messages': {
        const size = Math.round(asNumber(payload.value, this.config.windowMessages, 2, 20))
        this.config.windowMessages = size
        for (const [key, entries] of this.windows.entries()) {
          this.windows.set(key, entries.slice(-size))
        }
        this.broadcast()
        await this.saveState()
        return { ok: true }
      }

      case 'login-start': {
        return await this.startLogin()
      }

      case 'login-cancel': {
        return this.cancelLogin()
      }

      case 'logout': {
        return await this.logoutAll()
      }

      case 'send-reply': {
        const record = this.findMessage(String(payload.id ?? ''))
        if (!record) return { ok: false, error: '消息不存在' }
        const typed = String(payload.text ?? '').trim()
        const text = typed || String(record.suggestion?.text ?? '').trim()
        if (text === '') return { ok: false, error: '回复内容为空' }
        // 用户没改建议就点发送时，沿用模型拆好的多条（「给我发 10 条试试」这种需求）。
        const replies = typed === '' && Array.isArray(record.suggestion?.replies) ? record.suggestion.replies : []
        const ok = await this.deliver(record, text, { auto: false, replies })
        return { ok }
      }

      case 'regenerate': {
        const record = this.findMessage(String(payload.id ?? ''))
        if (!record) return { ok: false, error: '消息不存在' }
        record.suggestion = null
        await this.refreshSuggestion(record.id, { manual: true })
        return { ok: true }
      }

      case 'dismiss': {
        const record = this.findMessage(String(payload.id ?? ''))
        if (record) {
          record.dismissed = true
          if (record.status === 'needs-human') record.status = 'waiting'
          this.broadcast()
          await this.saveState()
        }
        return { ok: true }
      }

      case 'clear-inbox': {
        this.state.messages = []
        this.state.inboxNotice = '收件箱已清空'
        this.broadcast()
        await this.saveState()
        return { ok: true }
      }

      case 'remove': {
        const id = String(payload.id ?? '')
        this.state.messages = this.state.messages.filter((item) => item.id !== id)
        this.broadcast()
        await this.saveState()
        return { ok: true }
      }

      case 'restart-listeners': {
        await this.checkTool()
        await this.restartAll()
        return { ok: true }
      }

      case 'refresh': {
        await this.checkTool()
        await this.refreshProfiles()
        await this.refreshVision()
        this.startAllListeners()
        this.broadcast()
        return { ok: true }
      }

      case 'install-dws': {
        const result = await this.installDws(String(payload.version ?? ''))
        return { ...result, state: this.snapshot() }
      }

      case 'check-dws-update': {
        const install = await this.checkLatestDws()
        return {
          ok: install.latestError === '',
          error: install.latestError,
          state: this.snapshot(),
        }
      }

      case 'update-dws': {
        const result = await this.updateDws()
        return { ...result, state: this.snapshot() }
      }

      default:
        return { ok: false, error: `unknown action: ${type}` }
    }
  }

  // ------------------------------------------------------------------ snapshot

  snapshot() {
    const messages = this.state.messages
    const sources = new Map()
    for (const item of messages) {
      const key = item.sourceKey || sourceKeyOf(item)
      const existing = sources.get(key)
      if (existing) {
        existing.count += 1
        existing.lastAt = Math.max(existing.lastAt, item.at)
      } else {
        sources.set(key, {
          key,
          kind: item.kind,
          sender: item.sender,
          senderId: item.senderId,
          conversationTitle: item.conversationTitle,
          count: 1,
          lastAt: item.at,
        })
      }
    }

    const pending = messages.filter((item) => item.needsHuman && !item.dismissed && item.status !== 'replied')

    return {
      enabled: this.config.enabled,
      build: HOST_BUILD,
      started: this.started,
      tool: this.tool,
      install: this.install,
      selfName: this.state.selfName,
      currentProfile: this.state.currentProfile,
      profiles: this.state.profiles,
      expiredProfiles: this.expiredProfiles().map((item) => ({
        profile: item.profile,
        corpName: item.corpName,
        userName: item.userName,
        status: item.status,
      })),
      loginReset: this.config.loginReset,
      autoReply: this.state.autoReply,
      autoReplyAt: Number(this.state.autoReplyAt) || 0,
      autoSuggest: this.config.autoSuggest,
      notifyModal: this.config.notifyModal,
      minConfidence: this.config.minConfidence,
      contextMessages: this.config.contextMessages,
      windowMessages: this.config.windowMessages,
      windowCount: this.windows.size,
      remoteContext: this.config.remoteContext,
      remoteContextLimit: this.config.remoteContextLimit,
      imageRecognition: this.config.imageRecognition,
      imageMax: this.config.imageMax,
      vision: this.vision,
      replyPrefix: this.config.replyPrefix,
      groupReplyAt: this.config.groupReplyAt,
      multiSend: this.config.multiSend,
      multiSendMax: this.config.multiSendMax,
      multiSendDelayMs: this.config.multiSendDelayMs,
      dryRun: this.config.dryRun,
      model: this.modelInfo(),
      login: this.login,
      listeners: [...this.listeners.values()].map((entry) => ({
        profile: entry.profile,
        status: entry.status,
        since: entry.since,
        readyAt: entry.readyAt,
        lastEventAt: entry.lastEventAt,
        error: entry.error,
      })),
      messages: messages.map((item) => ({
        id: item.id,
        messageId: item.messageId,
        kind: item.kind,
        sender: item.sender,
        senderId: item.senderId,
        text: item.text,
        conversationId: item.conversationId,
        conversationTitle: item.conversationTitle,
        sourceKey: item.sourceKey,
        at: item.at,
        atText: formatClock(item.at),
        status: item.status,
        suggestion: item.suggestion,
        reply: item.reply,
        needsHuman: item.needsHuman,
        dismissed: item.dismissed,
        error: item.error,
        quoted: item.quoted,
        autoCancelled: Boolean(item.autoCancelled),
        sendAttempts: Number(item.sendAttempts) || 0,
        images: (Array.isArray(item.images) ? item.images : []).map((image, index) => ({
          index,
          state: image.state,
          mediaType: image.mediaType,
          bytes: image.bytes,
          error: image.error ?? '',
        })),
      })),
      sources: [...sources.values()].sort((a, b) => b.lastAt - a.lastAt),
      pendingCount: pending.length,
      requests: Array.isArray(this.requestLog) ? this.requestLog.slice(-8).map((entry) => ({
        at: entry.at,
        method: entry.method,
        status: entry.status,
        detail: entry.detail,
      })) : [],
      lastError: this.lastError ?? '',
      inboxNotice: String(this.state.inboxNotice ?? ''),
      serverTime: Date.now(),
    }
  }

  // ----------------------------------------------------------------- persistence

  async loadState() {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const payload = JSON.parse(raw)
      if (payload && typeof payload === 'object') {
        if (typeof payload.autoReply === 'boolean' && payload.autoReplyTouched === true) {
          this.state.autoReply = payload.autoReply
        }
        this.state.autoReplyTouched = payload.autoReplyTouched === true
        if (Number.isFinite(payload.autoReplyAt) && payload.autoReplyAt > 0) {
          this.state.autoReplyAt = payload.autoReplyAt
        } else if (this.state.autoReply) {
          // 老状态文件没有开启时间：按「一直开着」处理，不误伤升级后的自动回复。
          this.state.autoReplyAt = 0
        }
        if (Array.isArray(payload.messages)) {
          this.state.messages = payload.messages
            .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
            .slice(0, this.config.maxInbox)
            .map((item) =>
              healLegacyFailure({
                ...item,
                // 旧存档里的图片消息正文带着钉钉的下载提示，读档时顺手清理一遍。
                text: stripImageMarkers(String(item.text ?? '')),
                at: repairStoredTime(item.at),
                sender: String(item.sender ?? '未知联系人'),
                sourceKey: item.sourceKey || sourceKeyOf(item),
                suggestion: item.suggestion ?? null,
                reply: item.reply ?? null,
                needsHuman: Boolean(item.needsHuman),
                dismissed: Boolean(item.dismissed),
                error: String(item.error ?? ''),
                quoted: String(item.quoted ?? ''),
                images: Array.isArray(item.images) ? item.images : [],
                sendAttempts: Number(item.sendAttempts) || 0,
              }),
            )
        }
        if (payload.titles && typeof payload.titles === 'object') {
          for (const [key, value] of Object.entries(payload.titles)) {
            if (typeof value === 'string' && value !== '') this.titleCache.set(key, value)
          }
        }
        if (typeof payload.selfName === 'string' && payload.selfName !== '') {
          this.state.selfName = payload.selfName
        }
        if (typeof payload.minConfidence === 'number' && payload.minConfidence > 0 && payload.minConfidence <= 1) {
          this.config.minConfidence = payload.minConfidence
        }
        if (typeof payload.windowMessages === 'number' && payload.windowMessages >= 2 && payload.windowMessages <= 20) {
          this.config.windowMessages = Math.round(payload.windowMessages)
        }
        // 恢复每个来源的滑动窗口；老存档没有这一段，就等新消息进来再重建。
        this.restoreWindows(payload.windows)
      }
    } catch {
      // 首次运行或文件损坏：使用默认状态。
    }
  }

  saveState() {
    const payload = {
      version: 1,
      autoReply: this.state.autoReply,
      autoReplyTouched: this.state.autoReplyTouched,
      autoReplyAt: Number(this.state.autoReplyAt) || 0,
      minConfidence: this.config.minConfidence,
      windowMessages: this.config.windowMessages,
      selfName: this.state.selfName,
      titles: Object.fromEntries([...this.titleCache.entries()].filter(([, value]) => value !== '')),
      messages: this.state.messages.slice(0, this.config.maxInbox),
      windows: this.windowSnapshot(),
      savedAt: Date.now(),
    }

    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        const dir = dirname(this.statePath)
        await mkdir(dir, { recursive: true })
        const tmp = `${this.statePath}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, this.statePath)
      })
      .catch(async () => {
        try {
          await unlink(`${this.statePath}.${process.pid}.tmp`)
        } catch {
          // 忽略。
        }
      })

    return this.saveChain
  }
}

// 冒烟测试：用真实 dws 启动一次宿主机服务，验证工具链、profile、事件订阅与 HTTP 快照。
// 用法：node scripts/smoke.mjs [毫秒，默认 20000]
//
// 注意：默认在临时 DSH_HOME 里跑，避免本脚本的 saveState() 覆盖你正在使用的
// <真实 DSH_HOME>/integrations/dingtalk-bridge/state.json（那会把页面上的阈值、开关改回默认值）。
// 确实需要写真实状态时：SMOKE_REAL_HOME=1 node scripts/smoke.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DingTalkBridgeService } from '../src/host/service.js'

if (process.env.SMOKE_REAL_HOME !== '1') {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dingtalk-smoke-'))
  console.log(`[smoke] 使用临时 DSH_HOME: ${process.env.DSH_HOME}`)
}

const waitMs = Number(process.argv[2] ?? 20000)

const ctx = {
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    return null
  },
}

const service = new DingTalkBridgeService(ctx, {
  enabled: true,
  dwsPath: 'dws',
  listenDirect: true,
  listenGroupAt: true,
  autoReply: false,
  autoSuggest: false,
})

const stop = service.start()
console.log(`[smoke] 服务已启动，观察 ${waitMs}ms …`)

await new Promise((resolve) => setTimeout(resolve, waitMs))

const snapshot = service.snapshot()
console.log(
  JSON.stringify(
    {
      started: snapshot.started,
      tool: snapshot.tool,
      selfName: snapshot.selfName,
      currentProfile: snapshot.currentProfile,
      profileCount: snapshot.profiles.length,
      listeners: snapshot.listeners.map((item) => ({
        profile: item.profile,
        status: item.status,
        since: item.since,
        error: item.error,
        restarts: item.restarts,
      })),
      messageCount: snapshot.messages.length,
      autoReply: snapshot.autoReply,
    },
    null,
    2,
  ),
)

// 走一遍真实 HTTP 分发（GET /state）
const res = {
  statusCode: 0,
  body: '',
  writeHead(code) {
    this.statusCode = code
    return this
  },
  write(chunk) {
    this.body += chunk
    return true
  },
  end(chunk) {
    if (typeof chunk === 'string') this.body += chunk
    return this
  },
  on() {
    return this
  },
}
await service.dispatchHttp(ctx, { method: 'GET', url: '/api/dingtalk-bridge/state', on() {} }, res)
const decoded = JSON.parse(res.body)
console.log(`[smoke] GET /state -> ${res.statusCode}, ok=${decoded.ok}, messages=${decoded.state.messages.length}`)

const listening = snapshot.listeners.some((item) => item.status === 'online')
await stop?.()
console.log(`[smoke] 已停止。listener online = ${listening}`)
process.exit(listening && snapshot.tool.ok ? 0 : 1)

/**
 * 连续多条消息的演练自测：用 --dry-run 走真实的 dws 参数拼装，确认 3 条回复会
 * 依次生成 3 个发送计划（幂等键分别为 base / -p2 / -p3），不会真的发到钉钉。
 *
 * 用法：node scripts/multi-smoke.mjs
 */
import { DingTalkBridgeService } from '../src/host/service.js'

const SELF_OPEN_ID = 'DZxSz9PvHH4CctQwczX6u2GDUqyKOhmkf'
const SELF_DM_CID = 'cidCdAtUFzADZo7lvsgSvcb2R2l/cJBcu8E7b5ynB2MITI='

const ctx = {
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  effect() {},
}

const service = new DingTalkBridgeService(ctx, {
  enabled: true,
  dwsPath: 'dws',
  listenDirect: false,
  listenGroupAt: false,
  autoSuggest: false,
  autoReply: false,
  dryRun: true,
  multiSend: true,
  multiSendMax: 5,
  multiSendDelayMs: 100,
})
service.state.selfName = '自测'
service.state.selfOpenId = SELF_OPEN_ID

const record = {
  id: `multi-smoke-${Date.now().toString(36)}`,
  kind: 'dm',
  sender: '自测',
  senderId: SELF_OPEN_ID,
  conversationId: SELF_DM_CID,
  text: '给我发 3 条消息试试',
  at: Date.now(),
  status: 'suggested',
  images: [],
}

const ok = await service.deliver(record, '第一条', { auto: false, replies: ['第一条', '第二条', '第三条'] })
const reply = record.reply || {}

console.log(JSON.stringify({
  ok,
  status: record.status,
  partCount: reply.partCount,
  parts: (reply.parts || []).map((item) => ({ text: item.text, ok: item.ok })),
  text: reply.text,
  dryRun: reply.dryRun,
  error: reply.error,
}, null, 2))

const passed =
  ok === true &&
  reply.partCount === 3 &&
  Array.isArray(reply.parts) &&
  reply.parts.length === 3 &&
  reply.parts.every((item) => item.ok === true) &&
  reply.dryRun === true

console.log(passed ? 'ALL PASS' : 'FAILED')
process.exit(passed ? 0 : 1)

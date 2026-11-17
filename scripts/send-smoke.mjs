// 端到端发送冒烟：走插件的 deliver() 代码路径，向「自己」的钉钉会话真实发一条消息。
// 使用自己的 openDingTalkId 作为目标，不会打扰他人。
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dingtalk-send-smoke-'))

const { DingTalkBridgeService } = await import('../src/host/service.js')

const SELF_OPEN_ID = process.env.SELF_OPEN_ID || 'openIdZhangSan000000000000000000'

const ctx = {
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }) }
    return null
  },
}

const service = new DingTalkBridgeService(ctx, { enabled: true, dwsPath: 'dws', autoSuggest: false, autoReply: false })
await service.loadState()

// 构造一条「待回复」记录，指向自己的会话。
service.ingest('smoke-profile', {
  type: 'user_im_message_receive_o2o_all',
  event_id: `smoke-${Date.now()}`,
  message_id: `smoke-${Date.now()}`,
  sender: '发送自检',
  sender_open_dingtalk_id: SELF_OPEN_ID,
  conversation_id: '',
  content: '插件的发送通道自检（可忽略）',
  create_time: '2026-11-14 12:00:00',
})

// 注意：send-reply 走 handleAction 时传入的是 state 里的活对象；这里同样取活对象，便于观察结果。
const record = service.state.messages[0]
console.log('[send-smoke] 目标记录:', JSON.stringify({ id: record.id, kind: record.kind, sender: record.sender }))

const text = `钉钉消息助手发送自检 ${new Date().toLocaleTimeString('zh-CN')}，可忽略。`
await service.deliver(record, text, { auto: false })

const after = service.state.messages[0]
console.log('[send-smoke] reply =', JSON.stringify(after.reply))
console.log('[send-smoke] status =', after.status)
process.exit(after.reply && after.reply.ok ? 0 : 1)

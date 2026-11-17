/**
 * 图片链路冒烟：用真实钉钉消息下载图片，验证 mediaId 解析、落盘、类型嗅探与 /media 读取。
 *
 * 用法：
 *   node scripts/image-smoke.mjs <messageId> <openConversationId> <mediaId>
 * 参数省略时使用最近一条能拿到的图片消息（需先 `dws chat +chat-messages` 有图片消息）。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dingtalk-image-smoke-'))
process.env.DSH_HOME = home

const { DingTalkBridgeService } = await import('../src/host/service.js')

const ctx = {
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }) }
    return null
  },
}

const [messageId, conversationId, mediaId] = process.argv.slice(2)
if (!messageId || !mediaId) {
  console.error('用法: node scripts/image-smoke.mjs <messageId> <openConversationId> <mediaId>')
  process.exit(2)
}

const service = new DingTalkBridgeService(ctx, {
  enabled: true,
  dwsPath: 'dws',
  imageRecognition: true,
  imageMax: 4,
})
service.state.selfName = '张三'

const record = {
  id: 'image-smoke',
  messageId,
  kind: 'dm',
  sender: '李四',
  senderId: 'openIdLiSi0000000000000000000000',
  text: '[图片]',
  conversationId,
  conversationTitle: '',
  at: Date.now(),
  profile: '',
  sourceKey: 'dm:openIdLiSi0000000000000000000000',
  status: 'received',
  images: [{ mediaId, file: '', mediaType: '', bytes: 0, state: 'pending' }],
  suggestion: null,
  reply: null,
  needsHuman: false,
  dismissed: false,
  quoted: '',
  error: '',
}

console.log('[image-smoke] 下载图片 …')
await service.downloadImages(record)
const image = record.images[0]
console.log('[image-smoke] 结果:', JSON.stringify({ state: image.state, mediaType: image.mediaType, bytes: image.bytes, error: image.error }))

const media = await service.readMedia(record, 0)
console.log('[image-smoke] readMedia:', media ? `${media.mediaType} ${media.bytes.length} bytes` : 'null')

const snapshot = service.snapshot()
console.log('[image-smoke] snapshot.images:', JSON.stringify(snapshot.messages.map((item) => item.images)))

const ok = image.state === 'ready' && media !== null && media.bytes.length === image.bytes
console.log(ok ? '[image-smoke] 全部断言通过 ✅' : '[image-smoke] 图片链路失败 ❌')
process.exit(ok ? 0 : 1)

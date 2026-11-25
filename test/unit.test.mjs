import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DingTalkBridgeService, buildSendArgs, composeReplyBody, detectMessageKind, extractEventText, extractImageRefs, buildInstallArgs, isDuplicateSendFailure, looksLikeJsonEnvelope, looksLikeMissingCommand, sniffImageMediaType, stripImageMarkers, planReplyParts } from '../src/host/service.js'
import { buildSuggestPrompt, buildStreamOptions, cleanReply, parseSuggestion } from '../src/host/suggest.js'
import { createLineReader, describeFailure, parseLooseJson } from '../src/host/dws.js'
import { extractTarGz, tarballUrl } from '../src/host/dws-tar.js'

const home = await mkdtemp(join(tmpdir(), 'dingtalk-bridge-test-'))
process.env.DSH_HOME = home
test.after(async () => {
  // 后台任务可能还在写临时目录，重试几次再放弃清理。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
})

async function useFreshHome() {
  const dir = await mkdtemp(join(home, 'h-'))
  process.env.DSH_HOME = dir
  return dir
}

function makeCtx({ rejection, llmText } = {}) {
  return {
    get(name) {
      if (name === 'connection') {
        return {
          requestRejection: () => (typeof rejection === 'function' ? rejection() : rejection),
        }
      }
      if (name === 'llm' && llmText !== undefined) {
        return {
          async *stream() {
            yield { type: 'text-delta', text: llmText }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (name === 'agentDefaultModel' && llmText !== undefined) {
        return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      }
      return null
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    chunked: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    write(chunk) {
      this.chunked = true
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
}

function makeReq({ method = 'GET', url = '/', body = '' } = {}) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body)
    },
  }
}

function dmEvent(overrides = {}) {
  return {
    type: 'user_im_message_receive_o2o_all',
    event_id: 'evt-1',
    message_id: 'msg-1',
    sender: '张三',
    sender_open_dingtalk_id: 'open-zhangsan',
    conversation_id: 'cid-dm-1',
    content: '在吗？帮忙看下昨天的周报',
    create_time: Date.now(),
    ...overrides,
  }
}

// ------------------------------------------------------------------ dws helpers

test('parseLooseJson 从日志中截取 JSON', () => {
  assert.deepEqual(parseLooseJson('info: start\n{"a":1}\n'), { a: 1 })
  assert.equal(parseLooseJson('no json here'), null)
  assert.equal(parseLooseJson('{broken'), null)
})

test('createLineReader 按行切分并 flush 尾部', () => {
  const seen = []
  const reader = createLineReader((line) => seen.push(line))
  reader.push('{"a":1}\n{"b":')
  reader.push('2}\r\n\n')
  reader.flush()
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}'])
})

test('createLineReader 尾部残余也会被 flush', () => {
  const seen = []
  const reader = createLineReader((line) => seen.push(line))
  reader.push('{"a":1}')
  reader.flush()
  assert.deepEqual(seen, ['{"a":1}'])
})

test('describeFailure 优先给出可读错误', () => {
  assert.equal(describeFailure({ code: 1, stdout: '{"ok":false,"error":{"message":"boom"}}', stderr: '' }), 'boom')
  assert.equal(describeFailure({ code: 7, stdout: '', stderr: 'network down' }), 'network down')
  assert.match(describeFailure({ code: 2, stdout: '', stderr: '' }), /退出码 2/)
})

// ------------------------------------------------------------------ 事件解析

test('extractEventText 支持字符串 / 对象 / JSON 字符串', () => {
  assert.equal(extractEventText({ content: '你好' }), '你好')
  assert.equal(extractEventText({ content: { text: '对象内容' } }), '对象内容')
  assert.equal(extractEventText({ content: '{"text":"内嵌JSON"}' }), '内嵌JSON')
  assert.equal(extractEventText({ content: '  多行\n文本  ' }), '多行\n文本')
  assert.equal(extractEventText({ content: '', msgtype: 'picture' }), '[picture 消息]')
  assert.equal(extractEventText({}), '')
})

test('detectMessageKind 区分私信与群 @', () => {
  assert.equal(detectMessageKind({ type: 'user_im_message_receive_o2o_all' }), 'dm')
  assert.equal(detectMessageKind({ type: 'user_im_message_receive_at' }), 'group')
  assert.equal(detectMessageKind({ type: 'user_im_message_receive_at', conversation_title: '产品群' }), 'group')
  assert.equal(detectMessageKind({ conversation_type: '2' }), 'group')
})

// ------------------------------------------------------------------ 建议回复解析

test('parseSuggestion 解析标准 JSON', () => {
  const result = parseSuggestion('{"reply":"收到，我下午看","confidence":0.86,"needsHuman":false,"reason":"常见请求"}')
  assert.equal(result.ok, true)
  assert.equal(result.reply, '收到，我下午看')
  assert.equal(result.confidence, 0.86)
  assert.equal(result.needsHuman, false)
  assert.equal(result.format, 'json')
})

test('parseSuggestion 兼容代码块与中文引号', () => {
  const result = parseSuggestion('```json\n{"reply":"好的 👌","confidence":"0.9"}\n```')
  assert.equal(result.reply, '好的 👌')
  assert.equal(result.confidence, 0.9)
})

test('parseSuggestion 非 JSON 输出降级为草稿并要求人工确认', () => {
  const result = parseSuggestion('回复：我稍后回复你')
  assert.equal(result.ok, true)
  assert.equal(result.reply, '我稍后回复你')
  assert.equal(result.needsHuman, true)
  assert.equal(result.format, 'text')
})

test('parseSuggestion 空输出标记失败', () => {
  const result = parseSuggestion('   ')
  assert.equal(result.ok, false)
  assert.equal(result.reply, '')
  assert.equal(result.needsHuman, true)
})

test('cleanReply 去掉前缀与包裹引号', () => {
  assert.equal(cleanReply('回复：稍等'), '稍等')
  assert.equal(cleanReply('"好的"'), '好的')
  assert.equal(cleanReply('```\n行内代码\n```'), '行内代码')
})

test('buildSuggestPrompt 携带来源、发送人与上下文', () => {
  const prompt = buildSuggestPrompt({
    record: {
      kind: 'group',
      conversationTitle: '产品讨论群',
      sender: '李四',
      text: '这个需求什么时候能上线？',
      at: new Date('2026-11-13T10:30:00+08:00').getTime(),
    },
    history: [
      { direction: 'in', sender: '李四', text: '排期确认了吗', at: 1 },
      { direction: 'out', text: '今天会给结论', at: 2 },
    ],
    selfName: '张三',
  })
  assert.match(prompt.system, /张三/)
  assert.match(prompt.user, /群聊「产品讨论群」/)
  assert.match(prompt.user, /【发送人】李四/)
  assert.match(prompt.user, /- 李四：排期确认了吗/)
  assert.match(prompt.user, /- 张三：今天会给结论/)
  assert.match(prompt.user, /这个需求什么时候能上线？/)
  assert.match(prompt.user, /请直接输出 JSON/)
})

// ------------------------------------------------------------------ 发送参数

test('buildSendArgs 群聊走 --group 并带幂等键', () => {
  const args = buildSendArgs({
    record: { id: 'evt-9', kind: 'group', conversationId: 'cid-group-1', profile: 'corp:user' },
    body: '收到',
    auto: false,
  })
  assert.deepEqual(args.slice(0, 3), ['chat', '+messages-send', '--as'])
  assert.equal(args[args.indexOf('--group') + 1], 'cid-group-1')
  assert.equal(args[args.indexOf('--text') + 1], '收到')
  assert.equal(args[args.indexOf('--idempotency-key') + 1], 'dsh-dingtalk-evt-9')
  assert.ok(args.includes('--ai-tag=false'))
  assert.ok(args.includes('--yes'), '非交互环境必须显式确认，否则 dws 会 confirmation_required')
  assert.ok(!args.includes('--dry-run'))
  assert.equal(args[args.indexOf('--profile') + 1], 'corp:user')
  assert.ok(!args.includes('--open-dingtalk-id'))
})

test('buildSendArgs 演练模式用 --dry-run 替代 --yes', () => {
  const args = buildSendArgs({
    record: { id: 'evt-11', kind: 'dm', senderId: 'open-li' },
    body: '好的',
    auto: true,
    dryRun: true,
  })
  assert.ok(args.includes('--dry-run'))
  assert.ok(!args.includes('--yes'))
})

test('buildSendArgs 私信走 --open-dingtalk-id 且自动回复保留 AI 角标', () => {
  const args = buildSendArgs({
    record: { id: 'evt-10', kind: 'dm', senderId: 'open-li' },
    body: '好的',
    auto: true,
  })
  assert.equal(args[args.indexOf('--open-dingtalk-id') + 1], 'open-li')
  assert.ok(!args.includes('--ai-tag=false'))
  assert.ok(!args.includes('--group'))
})

// ------------------------------------------------------------------ 服务状态

test('ingest 记录消息源并按事件 id 去重', async () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  service.ingest('profile-1', dmEvent())
  service.ingest('profile-1', dmEvent())

  const snapshot = service.snapshot()
  assert.equal(snapshot.messages.length, 1)
  const message = snapshot.messages[0]
  assert.equal(message.kind, 'dm')
  assert.equal(message.sender, '张三')
  assert.equal(message.sourceKey, 'dm:open-zhangsan')
  assert.match(message.text, /周报/)
  assert.equal(snapshot.sources.length, 1)
  assert.equal(snapshot.sources[0].count, 1)
  assert.equal(snapshot.pendingCount, 0)
})

test('ingest 过滤自己发送的消息与不支持的事件类型', () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false })
  service.state.selfName = '张三'

  service.ingest('profile-1', dmEvent({ event_id: 'e-self', sender: '张三' }))
  service.ingest('profile-1', { type: 'user_im_message_reaction', event_id: 'e-react', sender: '张三' })
  service.ingest('profile-1', { type: 'user_im_chat_updated', event_id: 'e-chat', sender: '张三' })
  assert.equal(service.snapshot().messages.length, 0)
})

test('close 后的消息不再入箱（listenDirect 关闭时过滤私信）', () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, listenDirect: false })
  service.ingest('profile-1', dmEvent({ event_id: 'e-nodirect' }))
  assert.equal(service.snapshot().messages.length, 0)
})

// ------------------------------------------------------------------ 建议生成与自动回复判定

test('autoReply 关闭时只生成建议不发送', async () => {
  const llmText = '{"reply":"我下午看下再回复你","confidence":0.9,"needsHuman":false,"reason":"常见请求"}'
  const service = new DingTalkBridgeService(makeCtx({ llmText }), {
    autoSuggest: false,
    autoReply: false,
  })
  service.ingest('profile-1', dmEvent({ event_id: 'e-suggest' }))
  const id = service.snapshot().messages[0].id

  await service.refreshSuggestion(id)

  const message = service.snapshot().messages[0]
  assert.equal(message.suggestion.text, '我下午看下再回复你')
  assert.equal(message.suggestion.confidence, 0.9)
  assert.equal(message.status, 'suggested')
  assert.equal(message.reply, null)
})

test('autoReply 开启但置信度不足时转为人工确认', async () => {
  const llmText = '{"reply":"可能吧","confidence":0.3,"needsHuman":false,"reason":"信息不足"}'
  const service = new DingTalkBridgeService(makeCtx({ llmText }), {
    autoSuggest: false,
    autoReply: true,
    minConfidence: 0.72,
    notifyModal: true,
  })
  service.ingest('profile-1', dmEvent({ event_id: 'e-unclear' }))
  const id = service.snapshot().messages[0].id

  await service.refreshSuggestion(id)

  const message = service.snapshot().messages[0]
  assert.equal(message.status, 'needs-human')
  assert.equal(message.needsHuman, true)
  assert.equal(message.reply, null)
  assert.equal(service.snapshot().pendingCount, 1)
})

test('autoReply 开启且模型认为需人工时同样转人工', async () => {
  const llmText = '{"reply":"需要确认预算","confidence":0.95,"needsHuman":true,"reason":"缺少预算信息"}'
  const service = new DingTalkBridgeService(makeCtx({ llmText }), {
    autoSuggest: false,
    autoReply: true,
    minConfidence: 0.5,
  })
  service.ingest('profile-1', dmEvent({ event_id: 'e-human' }))
  const id = service.snapshot().messages[0].id
  await service.refreshSuggestion(id)
  assert.equal(service.snapshot().messages[0].status, 'needs-human')
})

// ------------------------------------------------------------------ HTTP 层

test('HTTP 路由拒绝未授权请求', async () => {
  const service = new DingTalkBridgeService(makeCtx({ rejection: { status: 403 } }), {})
  const res = makeRes()
  await service.dispatchHttp(makeCtx({ rejection: { status: 403 } }), makeReq({ url: '/api/dingtalk-bridge/state' }), res)
  assert.equal(res.statusCode, 403)
})

test('HTTP /state 返回快照', async () => {
  const ctx = makeCtx({ rejection: undefined })
  const service = new DingTalkBridgeService(ctx, { autoSuggest: false })
  service.ingest('profile-1', dmEvent({ event_id: 'e-http' }))
  const res = makeRes()
  await service.dispatchHttp(ctx, makeReq({ url: '/api/dingtalk-bridge/state' }), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.state.messages.length, 1)
  assert.equal(payload.state.autoReply, false)
})

test('HTTP /action 切换自动回复开关并持久化', async () => {
  await useFreshHome()
  const ctx = makeCtx({ rejection: undefined })
  const service = new DingTalkBridgeService(ctx, { autoReply: false })
  const res = makeRes()
  await service.dispatchHttp(
    ctx,
    makeReq({
      method: 'POST',
      url: '/api/dingtalk-bridge/action',
      body: JSON.stringify({ type: 'set-auto-reply', enabled: true }),
    }),
    res,
  )
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.state.autoReply, true)

  const reloaded = new DingTalkBridgeService(ctx, { autoReply: false })
  await reloaded.loadState()
  assert.equal(reloaded.state.autoReply, true)
})

test('HTTP /action 未知类型返回失败', async () => {
  const ctx = makeCtx({ rejection: undefined })
  const service = new DingTalkBridgeService(ctx, {})
  const res = makeRes()
  await service.dispatchHttp(
    ctx,
    makeReq({ method: 'POST', url: '/api/dingtalk-bridge/action', body: JSON.stringify({ type: 'nope' }) }),
    res,
  )
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /unknown action/)
})

test('dismiss 清空待确认计数', async () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false })
  service.ingest('profile-1', dmEvent({ event_id: 'e-dismiss' }))
  const id = service.snapshot().messages[0].id
  service.state.messages[0].needsHuman = true
  service.state.messages[0].status = 'needs-human'
  assert.equal(service.snapshot().pendingCount, 1)

  await service.handleAction(makeCtx(), { type: 'dismiss', id })
  assert.equal(service.snapshot().pendingCount, 0)
  assert.equal(service.snapshot().messages[0].dismissed, true)
})

// ------------------------------------------------------------------ 阈值设置与「换一条建议」

test('HTTP /action 调整自动回复阈值并持久化', async () => {
  await useFreshHome()
  const ctx = makeCtx({ rejection: undefined })
  const service = new DingTalkBridgeService(ctx, { minConfidence: 0.72 })
  const res = makeRes()
  await service.dispatchHttp(
    ctx,
    makeReq({
      method: 'POST',
      url: '/api/dingtalk-bridge/action',
      body: JSON.stringify({ type: 'set-min-confidence', value: 0.9 }),
    }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).state.minConfidence, 0.9)

  const reloaded = new DingTalkBridgeService(ctx, { minConfidence: 0.72 })
  await reloaded.loadState()
  assert.equal(reloaded.config.minConfidence, 0.9)
  assert.equal(reloaded.snapshot().minConfidence, 0.9)
})

test('阈值被限制在 0.3–1 之间', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx({ rejection: undefined }), { minConfidence: 0.72 })
  await service.handleAction(makeCtx(), { type: 'set-min-confidence', value: 0.05 })
  assert.equal(service.snapshot().minConfidence, 0.3)
  await service.handleAction(makeCtx(), { type: 'set-min-confidence', value: 3 })
  assert.equal(service.snapshot().minConfidence, 1)
})

test('GET /action 兜底通道也能设置阈值（POST 被拦时用）', async () => {
  await useFreshHome()
  const ctx = makeCtx({ rejection: undefined })
  const service = new DingTalkBridgeService(ctx, { minConfidence: 0.72 })
  const res = makeRes()
  await service.dispatchHttp(
    ctx,
    makeReq({ method: 'GET', url: '/api/dingtalk-bridge/action?type=set-min-confidence&value=0.55' }),
    res,
  )
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.state.minConfidence, 0.55)
  assert.equal(service.snapshot().minConfidence, 0.55)

  const auto = makeRes()
  await service.dispatchHttp(
    ctx,
    makeReq({ method: 'GET', url: '/api/dingtalk-bridge/action?type=set-auto-reply&enabled=false' }),
    auto,
  )
  assert.equal(JSON.parse(auto.body).state.autoReply, false)
})

test('请求被宿主拒绝时记录状态码与请求信息', async () => {
  await useFreshHome()
  const ctx = makeCtx({ rejection: 403 })
  const service = new DingTalkBridgeService(ctx, {})
  const res = makeRes()
  await service.dispatchHttp(
    ctx,
    makeReq({ method: 'POST', url: '/api/dingtalk-bridge/action', body: '{"type":"set-min-confidence"}' }),
    res,
  )
  assert.equal(res.statusCode, 403)
  const state = service.snapshot()
  assert.equal(state.lastError.includes('403'), true)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].status, 403)
  assert.match(state.requests[0].detail, /site=|origin=|host=/)
})

test('换一条建议只更新建议，不触发自动发送', async () => {
  const llmText = '{"reply":"稍等我看下","confidence":0.99,"needsHuman":false,"reason":"明确"}'
  const service = new DingTalkBridgeService(makeCtx({ llmText }), {
    autoSuggest: false,
    autoReply: true,
    minConfidence: 0.5,
  })
  service.ingest('profile-1', dmEvent({ event_id: 'e-regen' }))
  const id = service.snapshot().messages[0].id

  await service.handleAction(makeCtx(), { type: 'regenerate', id })

  const message = service.snapshot().messages[0]
  assert.equal(message.suggestion.text, '稍等我看下')
  assert.equal(message.reply, null, '换建议不得自动发送')
  assert.equal(message.status, 'suggested')
  assert.equal(message.needsHuman, false)
})

test('snapshot 暴露当前使用的模型与登录状态', async () => {
  const service = new DingTalkBridgeService(makeCtx({ llmText: '{"reply":"好"}' }), {})
  const snapshot = service.snapshot()
  assert.ok(snapshot.model && typeof snapshot.model === 'object', '应暴露 model 信息')
  assert.equal(snapshot.model.provider, 'mock')
  assert.equal(snapshot.model.model, 'mock-1')
  assert.equal(snapshot.model.source, 'dsh')
  assert.ok(snapshot.login && typeof snapshot.login === 'object', '应暴露登录状态')
  assert.equal(snapshot.login.status, 'idle')
})

test('未配置任何模型时 snapshot 不抛错', async () => {
  const service = new DingTalkBridgeService(makeCtx(), {})
  const snapshot = service.snapshot()
  assert.equal(snapshot.model.source, 'none')
  assert.equal(snapshot.model.model, '')
})

// ------------------------------------------------------------------ 历史脏时间戳修正

test('读取存档时修正 1970 这类脏时间戳', async () => {
  const dir = await useFreshHome()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const target = join(dir, 'integrations', 'dingtalk-bridge')
  await mkdir(target, { recursive: true })
  const now = Date.now()
  await writeFile(
    join(target, 'state.json'),
    JSON.stringify({
      version: 1,
      messages: [
        { id: 'dirty', text: '改了什么', sender: '李四', at: 2026000, status: 'received' },
        { id: 'future', text: '未来的消息', sender: '李四', at: now + 90 * 86400000, status: 'received' },
        { id: 'clean', text: '正常时间', sender: '李四', at: now, status: 'received' },
      ],
    }),
    'utf8',
  )

  const service = new DingTalkBridgeService(makeCtx(), {})
  await service.loadState()

  const messages = service.snapshot().messages
  const dirty = messages.find((item) => item.id === 'dirty')
  const future = messages.find((item) => item.id === 'future')
  assert.ok(dirty.atText !== '1970-01-01 08:33', `脏时间应被修正，实际 ${dirty.atText}`)
  assert.ok(Math.abs(dirty.at - Date.now()) < 120000, '脏时间应回退到当前时间附近')
  assert.ok(future.at <= Date.now() + 86400000, '超出一天的未来时间应回退到当前时间附近')
  assert.ok(Math.abs(messages.find((item) => item.id === 'clean').at - now) < 1000, '正常时间应原样保留')
})

test('读取存档后正文与状态不受时间修正影响', async () => {
  const dir = await useFreshHome()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const target = join(dir, 'integrations', 'dingtalk-bridge')
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, 'state.json'),
    JSON.stringify({
      messages: [
        {
          id: 'keep',
          text: '有没有配置可以不检验交易日',
          sender: '李四',
          senderId: 'openIdLiSi0000000000000000000000',
          conversationId: 'cid-1',
          kind: 'dm',
          status: 'needs-human',
          needsHuman: true,
          at: 2026000,
        },
      ],
    }),
    'utf8',
  )

  const service = new DingTalkBridgeService(makeCtx(), {})
  await service.loadState()
  const message = service.snapshot().messages[0]
  assert.equal(message.text, '有没有配置可以不检验交易日')
  assert.equal(message.status, 'needs-human')
  assert.equal(message.needsHuman, true)
  assert.equal(message.senderId, 'openIdLiSi0000000000000000000000')
  assert.equal(service.snapshot().pendingCount, 1)
})

// ------------------------------------------------------------------ 旧失败记录自愈

test('读取存档时清理旧版 confirmation_required 失败记录', async () => {
  const dir = await useFreshHome()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const target = join(dir, 'integrations', 'dingtalk-bridge')
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, 'state.json'),
    JSON.stringify({
      messages: [
        {
          id: 'legacy-fail',
          text: 'ok',
          sender: '李四',
          kind: 'dm',
          status: 'failed',
          at: Date.now(),
          suggestion: { text: '好的，有问题随时找我。', confidence: 0.82, needsHuman: false, reason: '简单回应' },
          reply: { text: '好的', at: Date.now(), ok: false, error: 'dws chat +messages-send 需要用户确认，当前环境无法交互；加 --dry-run 预览，或确认后加 --yes 执行', auto: false },
          error: 'dws chat +messages-send 需要用户确认',
        },
        {
          id: 'real-fail',
          text: '真实失败',
          sender: '李四',
          kind: 'dm',
          status: 'failed',
          at: Date.now(),
          reply: { text: 'x', at: Date.now(), ok: false, error: 'OPEN_CID_INVALID', auto: false },
        },
      ],
    }),
    'utf8',
  )

  const service = new DingTalkBridgeService(makeCtx(), {})
  await service.loadState()
  const messages = service.snapshot().messages
  const healed = messages.find((item) => item.id === 'legacy-fail')
  assert.equal(healed.reply, null, '旧版确认失败应被清除')
  assert.equal(healed.error, '')
  assert.equal(healed.status, 'suggested')
  const real = messages.find((item) => item.id === 'real-fail')
  assert.ok(real.reply && real.reply.ok === false, '真实失败记录应保留，便于排查')
})

// ------------------------------------------------------------------ 图片消息

test('extractImageRefs 从正文里抠出 mediaId 并去重', () => {
  const refs = extractImageRefs({
    content: '[图片消息](mediaId=@lXLaaaBBB111)\n这是说明文字\n[图片消息](mediaId=@lXLaaaBBB111)',
  })
  assert.equal(refs.length, 1)
  assert.equal(refs[0].mediaId, '@lXLaaaBBB111')
  assert.deepEqual(extractImageRefs({ content: '纯文本，没有图片' }), [])
})

test('stripImageMarkers 把图片标记替换成 [图片] 并压掉多余空白', () => {
  assert.equal(stripImageMarkers('[图片消息](mediaId=@abc)\n看看这个'), '[图片]\n看看这个'.replace(/\s+/g, ' '))
  assert.equal(stripImageMarkers('没有图片'), '没有图片')
  assert.equal(stripImageMarkers(''), '')
})

test('sniffImageMediaType 按文件头判断真实图片类型', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
  const gif = Buffer.from('GIF89a0000000000', 'ascii')
  const webp = Buffer.from('RIFF0000WEBPVP8 ', 'ascii')
  assert.equal(sniffImageMediaType(png), 'image/png')
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
  assert.equal(sniffImageMediaType(gif), 'image/gif')
  assert.equal(sniffImageMediaType(webp), 'image/webp')
  assert.equal(sniffImageMediaType(Buffer.from('not an image at all', 'ascii')), '')
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), '')
})

test('图片消息只含图片时也会入箱并记下 images', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { imageRecognition: true, imageMax: 2 })
  // 不带 message_id：下载会立刻失败退出，用例不留下后台任务与临时文件。
  await service.ingest('ding:1', {
    type: 'user_im_message_receive_o2o_all',
    event_id: 'evt-img-1',
    sender: '李四',
    sender_open_dingtalk_id: 'openIdLiSi0000000000000000000000',
    conversation_id: 'cid-1',
    content: '[图片消息](mediaId=@mediaAAA)\n[图片消息](mediaId=@mediaBBB)',
    create_time: '2026-11-14 11:31:27',
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const message = service.snapshot().messages[0]
  assert.equal(message.text, '[图片] [图片]')
  assert.equal(message.images.length, 2)
  assert.equal(message.images[0].state, 'failed')
  assert.match(message.images[0].error, /message_id/)
  assert.ok(Number.isFinite(message.at) && message.at > Date.parse('2026-01-01'), '时间应被正确解析')
})

test('imageRecognition 关闭时不登记图片', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { imageRecognition: false })
  await service.ingest('ding:1', {
    type: 'user_im_message_receive_o2o_all',
    event_id: 'evt-img-2',
    sender: '李四',
    content: '[图片消息](mediaId=@mediaCCC)',
  })
  const message = service.snapshot().messages[0]
  assert.deepEqual(message.images, [])
  assert.equal(message.text, '[图片]')
})

// ------------------------------------------------------------------ 上下文与多模态

test('buildSuggestPrompt 在带图片时提示模型直接看图', () => {
  const prompt = buildSuggestPrompt({
    record: { kind: 'dm', sender: '李四', text: '看下这个报错', at: Date.now() },
    imageCount: 2,
  })
  assert.match(prompt.user, /附带 2 张图片/)
  const fallback = buildSuggestPrompt({
    record: { kind: 'dm', sender: '李四', text: '看下这个报错', at: Date.now() },
    imageNote: '（消息含图片，但当前模型不支持图片输入，已忽略图片内容）',
  })
  assert.match(fallback.user, /不支持图片输入/)
})

test('buildStreamOptions 把图片块拼进 content', () => {
  const options = buildStreamOptions({
    selection: { provider: 'p', model: 'm' },
    system: 's',
    user: 'u',
    images: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
  })
  assert.equal(options.messages[0].content.length, 2)
  assert.equal(options.messages[0].content[1].type, 'image')
})

test('snapshot 暴露远程上下文与图片相关配置', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), {})
  const snapshot = service.snapshot()
  assert.equal(snapshot.remoteContext, true)
  assert.equal(snapshot.remoteContextLimit, 10)
  assert.equal(snapshot.imageRecognition, true)
  assert.equal(snapshot.imageMax, 2)
})

// ------------------------------------------------------------------ 多模态交给模型

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

async function readyImageRecord() {
  const dir = await useFreshHome()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const media = join(dir, 'integrations', 'dingtalk-bridge', 'media')
  await mkdir(media, { recursive: true })
  await writeFile(join(media, 'shot.png'), PNG_BYTES)
  return {
    id: 'evt-img-9',
    messageId: 'msg-img-9',
    kind: 'dm',
    sender: '李四',
    senderId: 'openIdLiSi0000000000000000000000',
    conversationId: 'cid-1',
    text: '[图片]',
    at: Date.now(),
    images: [{ mediaId: '@m1', file: 'media/shot.png', mediaType: 'image/png', bytes: PNG_BYTES.length, state: 'ready' }],
  }
}

function imageCtx({ modalities = ['text', 'image'], withAttachments = true, saved = [] } = {}) {
  return {
    get(name) {
      if (name === 'attachments') {
        if (!withAttachments) return null
        return {
          async saveImage(input) {
            saved.push(input)
            return {
              attachmentId: `att-${saved.length}`,
              mediaType: input.mediaType,
              bytes: input.data.length,
              width: 640,
              height: 480,
              name: input.name,
            }
          },
        }
      }
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            return { inputModalities: modalities }
          },
        }
      }
      return null
    },
  }
}

const SELECTION = { provider: 'p', model: 'm' }

test('模型支持视觉时把图片转成 image block', async () => {
  const record = await readyImageRecord()
  const saved = []
  const service = new DingTalkBridgeService(imageCtx({ saved }), {})
  const result = await service.buildImageBlocks(record, SELECTION, service.ctx.get('llm'))
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0].type, 'image')
  assert.equal(result.blocks[0].attachment.attachmentId, 'att-1')
  assert.equal(result.note, '')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(saved[0].data.length, PNG_BYTES.length)
})

test('模型不支持图片输入时降级为文字说明', async () => {
  const record = await readyImageRecord()
  const service = new DingTalkBridgeService(imageCtx({ modalities: ['text'] }), {})
  const result = await service.buildImageBlocks(record, SELECTION, service.ctx.get('llm'))
  assert.equal(result.blocks.length, 0)
  assert.match(result.note, /不支持图片输入/)
})

test('缺少附件服务时降级为文字说明', async () => {
  const record = await readyImageRecord()
  const service = new DingTalkBridgeService(imageCtx({ withAttachments: false }), {})
  const result = await service.buildImageBlocks(record, SELECTION, service.ctx.get('llm'))
  assert.equal(result.blocks.length, 0)
  assert.match(result.note, /无法读取图片内容/)
})

// ------------------------------------------------------------------ 授权方式

test('授权默认走 loopback（无需授权码），可切到 device', async () => {
  await useFreshHome()
  const def = new DingTalkBridgeService(makeCtx(), {})
  assert.equal(def.config.loginMode, 'loopback')

  const device = new DingTalkBridgeService(makeCtx(), { loginMode: 'device' })
  assert.equal(device.config.loginMode, 'device')

  const bogus = new DingTalkBridgeService(makeCtx(), { loginMode: 'whatever' })
  assert.equal(bogus.config.loginMode, 'loopback')
})

test('loopback 授权流程只在 device 模式才生成二维码', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), {})
  service.login = { ...service.login, status: 'pending', mode: 'loopback' }
  service.handleLoginLine('请在浏览器中完成扫码授权。')
  service.handleLoginLine('https://login.dingtalk.com/oauth2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A59366%2Fcallback')
  assert.match(service.login.url, /login\.dingtalk\.com\/oauth2\/auth/)
  assert.equal(service.login.qr, '')
  assert.match(service.login.message, /打开钉钉授权页面/)

  service.login = { ...service.login, status: 'pending', mode: 'device', qr: '' }
  service.handleLoginLine('授权码: ABCD-EFGH')
  service.handleLoginLine('https://login.dingtalk.com/oauth2/device/verify.htm?user_code=ABCD-EFGH')
  assert.equal(service.login.code, 'ABCD-EFGH')
  // 二维码是异步生成的，等一拍再断言。
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(service.login.qr.startsWith('data:image/png;base64,'))
})

// ------------------------------------------------------------------ 重新授权 / 退出登录

const FAKE_DWS = 'dws-not-installed-for-test'

test('loginReset 默认开启：重新授权会先退出旧组织', async () => {
  await useFreshHome()
  assert.equal(new DingTalkBridgeService(makeCtx(), {}).config.loginReset, true)
  assert.equal(new DingTalkBridgeService(makeCtx(), { loginReset: false }).config.loginReset, false)
})

test('targetProfiles 跳过登录态过期的组织', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), {})
  service.state.profiles = [
    { profile: 'corp-a:user', corpName: 'A', userId: 'user', userName: '甲', status: 'active' },
    { profile: 'corp-b:user', corpName: 'B', userId: 'user', userName: '乙', status: 'expired' },
  ]
  service.state.currentProfile = 'corp-b:user'
  // 当前组织已过期 → 只监听仍然有效的组织，避免监听进程反复报鉴权失败。
  assert.deepEqual(service.targetProfiles(), ['corp-a:user'])
  assert.equal(service.expiredProfiles().length, 1)

  service.state.currentProfile = 'corp-a:user'
  assert.deepEqual(service.targetProfiles(), ['corp-a:user'])
})

test('logoutAll 会清空组织缓存并停止监听', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { dwsPath: FAKE_DWS })
  service.state.profiles = [{ profile: 'corp-a:user', corpName: 'A', userId: 'user', userName: '甲', status: 'active' }]
  service.state.currentProfile = 'corp-a:user'
  service.state.selfName = '甲'
  // dws 本身是好的，只是这次 logout 命令会失败（假命令）。
  service.tool = { ok: true, version: '1.0.68', error: '', checkedAt: Date.now() }

  const result = await service.logoutAll()
  // 假命令必然失败，但本地状态一定要先清干净，界面才不会继续显示旧组织。
  assert.equal(result.ok, false)
  assert.deepEqual(service.state.profiles, [])
  assert.equal(service.state.currentProfile, '')
  assert.equal(service.state.selfName, '')
  // 退出登录不是 dws 故障：tool.ok 必须保持不变，否则界面会误报「未检测到 dws 命令」。
  assert.equal(service.tool.ok, true)
  assert.match(service.snapshot().loginNotice, /退出登录/)
  assert.equal(service.snapshot().profiles.length, 0)
  assert.equal(service.snapshot().loginReset, true)
})

test('已知登录态时 startLogin 会先退出旧组织再申请授权', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { dwsPath: FAKE_DWS })
  // 这个用例只验证「重新授权前先退出旧组织」，所以假装 dws 可用，
  // 否则会先被「dws 未就绪，请先安装」的护栏挡住。
  service.tool = { ok: true, version: '1.0.0', error: '' }
  service.state.profiles = [{ profile: 'corp-a:user', corpName: 'A', userId: 'user', userName: '甲', status: 'active' }]
  service.state.currentProfile = 'corp-a:user'
  assert.equal(service.hasLogin(), true)

  await service.startLogin()
  // logoutAll 先跑，组织被清空；随后 startLogin 才把 login 置为 pending。
  assert.deepEqual(service.state.profiles, [])
  assert.equal(service.login.status, 'pending')
  service.cancelLogin()
  assert.equal(service.login.status, 'idle')
})




// ------------------------------------------------------------------ 自动回复开关时序 / 收件箱清空

test('stripImageMarkers 去掉钉钉图片下载提示', () => {
  assert.equal(
    stripImageMarkers('[图片] 注意：如需下载使用dws chat message download-media命令下载'),
    '[图片]',
  )
  assert.equal(stripImageMarkers('看这个 [图片消息](mediaId=@abc) 效果'), '看这个 [图片] 效果')
})

test('canAutoReply 只放行「本次开启之后」到达的消息', () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  service.state.autoReply = true
  service.state.autoReplyAt = 5000
  assert.equal(service.canAutoReply({ at: 1000 }), false)
  assert.equal(service.canAutoReply({ at: 6000 }), true)
  service.state.autoReply = false
  assert.equal(service.canAutoReply({ at: 6000 }), false)
})

test('关闭自动回复会取消生成中的自动回复，重新开启也不补发', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: true })
  service.ingest('profile-1', dmEvent({ event_id: 'e-old', create_time: Date.now() - 60_000 }))
  const message = service.state.messages[0]
  message.at = Date.now() - 60_000
  message.status = 'suggesting'

  await service.handleAction(makeCtx(), { type: 'set-auto-reply', enabled: false })
  assert.equal(message.autoCancelled, true)

  await service.handleAction(makeCtx(), { type: 'set-auto-reply', enabled: true })
  assert.equal(service.snapshot().autoReply, true)
  // 消息早于本次开启时间，因此重新开启后不会被自动回复。
  assert.equal(service.canAutoReply(message), false)
})

test('resetInbox 清空收件箱并记下原因', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  service.ingest('profile-1', dmEvent({ event_id: 'e-a' }))
  service.ingest('profile-1', dmEvent({ event_id: 'e-b' }))
  assert.equal(service.snapshot().messages.length, 2)

  service.resetInbox('重新授权成功，已清空旧消息')
  const snapshot = service.snapshot()
  assert.equal(snapshot.messages.length, 0)
  assert.equal(snapshot.sources.length, 0)
  assert.match(snapshot.inboxNotice, /重新授权/)
})

test('snapshot 暴露 autoReplyAt / autoCancelled / inboxNotice', () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: true })
  service.ingest('profile-1', dmEvent({ event_id: 'e-c' }))
  service.state.messages[0].autoCancelled = true
  const snapshot = service.snapshot()
  assert.equal(typeof snapshot.autoReplyAt, 'number')
  assert.ok(snapshot.autoReplyAt > 0)
  assert.equal(snapshot.messages[0].autoCancelled, true)
  assert.equal(typeof snapshot.inboxNotice, 'string')
})

test('GET /media 返回图片字节流', async () => {
  const home = await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  const id = 'msg-media-1'
  const file = join(home, 'integrations', 'dingtalk-bridge', 'media', 'shot.png')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))
  service.state.messages = [
    {
      id,
      kind: 'dm',
      sender: '张三',
      senderId: 'open-zhangsan',
      text: '[图片]',
      at: Date.now(),
      status: 'suggested',
      images: [{ mediaId: '@m', file: 'media/shot.png', mediaType: 'image/png', bytes: 12, state: 'ready' }],
    },
  ]

  const res = makeRes()
  await service.dispatchHttp(
    makeCtx(),
    makeReq({ method: 'GET', url: `/api/dingtalk-bridge/media?id=${encodeURIComponent(id)}&i=0` }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(String(res.headers['content-length']), '12')

  const missing = makeRes()
  await service.dispatchHttp(makeCtx(), makeReq({ method: 'GET', url: '/api/dingtalk-bridge/media?id=nope&i=0' }), missing)
  assert.equal(missing.statusCode, 404)
})

test('GET /icon 返回插件图标 PNG', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false })
  const captured = { statusCode: 0, headers: null, bytes: null }
  const res = {
    statusCode: 0,
    headers: null,
    writeHead(status, headers) {
      captured.statusCode = status
      captured.headers = headers
      this.statusCode = status
      this.headers = headers
      return this
    },
    write() {
      return true
    },
    end(chunk) {
      captured.bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      return this
    },
    on() {
      return this
    },
  }
  await service.dispatchHttp(makeCtx(), makeReq({ method: 'GET', url: '/api/dingtalk-bridge/icon' }), res)
  assert.equal(captured.statusCode, 200)
  assert.equal(captured.headers['content-type'], 'image/png')
  assert.ok(captured.bytes.length > 1000, `icon bytes ${captured.bytes.length}`)
  assert.equal(captured.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
})

test('buildSendArgs 重试时换新的幂等键，避免钉钉判重复', () => {
  const record = { id: 'evt-9', kind: 'dm', senderId: 'open-a' }
  const first = buildSendArgs({ record, body: '你好' })
  const second = buildSendArgs({ record, body: '你好', attempt: 1 })
  const third = buildSendArgs({ record, body: '你好', attempt: 2 })
  const keyOf = (args) => args[args.indexOf('--idempotency-key') + 1]
  assert.equal(keyOf(first), 'dsh-dingtalk-evt-9')
  assert.equal(keyOf(second), 'dsh-dingtalk-evt-9-r2')
  assert.equal(keyOf(third), 'dsh-dingtalk-evt-9-r3')
  assert.notEqual(keyOf(first), keyOf(second))
})

test('isDuplicateSendFailure 识别钉钉幂等键重复报错', () => {
  assert.equal(
    isDuplicateSendFailure(
      "sendPersonalMessageByServerPush error: Request is repeated with uuid 'dsh-dingtalk-dbd370157d19431a8dbac6166ceaab98'.",
    ),
    true,
  )
  assert.equal(isDuplicateSendFailure('confirmation_required'), false)
  assert.equal(isDuplicateSendFailure(''), false)
})

test('撞过幂等键的历史记录重发时直接从 -r2 起', () => {
  // 单独验证「重试计数」规则：attempt 从 0 开始，撞键后至少从 1 起
  const record = { id: 'evt-old', kind: 'dm', senderId: 'open-a' }
  const burned = { reply: { ok: false, duplicate: true }, sendAttempts: 0 }
  const attempt = Math.max(0, Number(burned.sendAttempts) || 0, burned.reply.duplicate ? 1 : 0)
  const args = buildSendArgs({ record, body: '重发一次', attempt })
  const key = args[args.indexOf('--idempotency-key') + 1]
  assert.equal(key, 'dsh-dingtalk-evt-old-r2')
})

test('composeReplyBody 群消息先 @ 发送人，私信不 @', () => {
  const group = { id: 'e1', kind: 'group', senderId: 'open-zhangsan', conversationId: 'cid-1' }
  const dm = { id: 'e2', kind: 'dm', senderId: 'open-zhangsan', conversationId: 'cid-2' }

  assert.equal(composeReplyBody({ record: group, text: '收到', atSender: true }), '<@open-zhangsan> 收到')
  assert.equal(composeReplyBody({ record: group, text: '收到', atSender: false }), '收到')
  assert.equal(composeReplyBody({ record: dm, text: '收到', atSender: true }), '收到')
  assert.equal(
    composeReplyBody({ record: group, text: '收到', replyPrefix: '[AI] ', atSender: true }),
    '<@open-zhangsan> [AI] 收到',
  )
  // 群消息缺少 openDingTalkId 时不能拼出半截占位符。
  assert.equal(composeReplyBody({ record: { ...group, senderId: '' }, text: '收到', atSender: true }), '收到')
})

test('buildSendArgs 群 @ 回复带 --at-open-dingtalk-ids，私信不带', () => {
  const group = { id: 'e1', kind: 'group', senderId: 'open-zhangsan', conversationId: 'cid-1' }
  const dm = { id: 'e2', kind: 'dm', senderId: 'open-zhangsan', conversationId: 'cid-2' }

  const groupArgs = buildSendArgs({ record: group, body: '<@open-zhangsan> 收到', atSender: true })
  assert.ok(groupArgs.includes('--at-open-dingtalk-ids'))
  assert.equal(groupArgs[groupArgs.indexOf('--at-open-dingtalk-ids') + 1], 'open-zhangsan')

  const groupOff = buildSendArgs({ record: group, body: '收到', atSender: false })
  assert.ok(!groupOff.includes('--at-open-dingtalk-ids'))

  const dmArgs = buildSendArgs({ record: dm, body: '收到', atSender: true })
  assert.ok(!dmArgs.includes('--at-open-dingtalk-ids'))
})

test('shouldAtSender 只在群消息 + 有 openDingTalkId 时成立，可被配置关掉', () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  assert.equal(service.shouldAtSender({ kind: 'group', senderId: 'u1', conversationId: 'c1' }), true)
  assert.equal(service.shouldAtSender({ kind: 'dm', senderId: 'u1', conversationId: 'c1' }), false)
  assert.equal(service.shouldAtSender({ kind: 'group', senderId: '', conversationId: 'c1' }), false)
  assert.equal(service.shouldAtSender(null), false)

  const off = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false, groupReplyAt: false })
  assert.equal(off.shouldAtSender({ kind: 'group', senderId: 'u1', conversationId: 'c1' }), false)
  assert.equal(off.snapshot().groupReplyAt, false)
})

test('每个来源的滑动窗口只保留最近 N 条', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, windowMessages: 3 })
  const base = Date.now() - 10_000
  for (let index = 0; index < 5; index += 1) {
    service.ingest(
      'profile-1',
      dmEvent({ event_id: `e-w${index}`, message_id: `m-w${index}`, content: `第 ${index} 条`, create_time: base + index * 1000 }),
    )
  }
  const list = service.windows.get('dm:open-zhangsan')
  assert.equal(list.length, 3)
  assert.deepEqual(
    list.map((item) => item.text),
    ['第 2 条', '第 3 条', '第 4 条'],
  )
  assert.equal(service.snapshot().windowMessages, 3)
  assert.equal(service.snapshot().windowCount, 1)
})

test('不同来源各自维护独立的窗口，互不串味', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, windowMessages: 5 })
  const base = Date.now() - 10_000
  service.ingest('profile-1', dmEvent({ event_id: 'a1', message_id: 'a1', content: '张三的第一句', create_time: base }))
  service.ingest(
    'profile-1',
    dmEvent({
      event_id: 'b1',
      message_id: 'b1',
      sender: '李四',
      sender_open_dingtalk_id: 'open-lisi',
      conversation_id: 'cid-dm-2',
      content: '李四的第一句',
      create_time: base + 500,
    }),
  )
  service.ingest('profile-1', dmEvent({ event_id: 'a2', message_id: 'a2', content: '张三的第二句', create_time: base + 1000 }))

  const zhangsan = service.windows.get('dm:open-zhangsan')
  const lisi = service.windows.get('dm:open-lisi')
  assert.deepEqual(zhangsan.map((item) => item.text), ['张三的第一句', '张三的第二句'])
  assert.deepEqual(lisi.map((item) => item.text), ['李四的第一句'])
  assert.equal(service.snapshot().windowCount, 2)
})

test('buildHistory 只取本来源窗口里的消息', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, windowMessages: 4, remoteContext: false })
  const base = Date.now() - 20_000
  service.ingest('profile-1', dmEvent({ event_id: 'x1', message_id: 'x1', content: '张三问：报表好了吗', create_time: base }))
  service.ingest(
    'profile-1',
    dmEvent({
      event_id: 'y1',
      message_id: 'y1',
      sender: '李四',
      sender_open_dingtalk_id: 'open-lisi',
      conversation_id: 'cid-dm-2',
      content: '李四问：合同签了吗',
      create_time: base + 1000,
    }),
  )
  service.ingest('profile-1', dmEvent({ event_id: 'x2', message_id: 'x2', content: '张三又说：尽快', create_time: base + 2000 }))
  const record = service.state.messages.find((item) => item.messageId === 'x2')
  const history = await service.buildHistory(record)
  assert.deepEqual(
    history.map((item) => item.text),
    ['张三问：报表好了吗'],
  )
  assert.ok(history.every((item) => !item.text.includes('李四')))
})

test('滑动窗口会持久化，重启后上下文不丢', async () => {
  const dir = await useFreshHome()
  const first = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, windowMessages: 3 })
  const base = Date.now() - 5_000
  first.ingest('profile-1', dmEvent({ event_id: 'p1', message_id: 'p1', content: '持久化一', create_time: base }))
  first.ingest('profile-1', dmEvent({ event_id: 'p2', message_id: 'p2', content: '持久化二', create_time: base + 1000 }))
  await first.saveState()

  const second = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, windowMessages: 3 })
  await second.loadState()
  const restored = second.windows.get('dm:open-zhangsan')
  assert.ok(Array.isArray(restored))
  assert.deepEqual(restored.map((item) => item.text), ['持久化一', '持久化二'])
  assert.equal(second.snapshot().windowCount, 1)
  assert.ok(dir.length > 0)
})

test('清空收件箱会同时清掉所有滑动窗口', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false })
  service.ingest('profile-1', dmEvent({ event_id: 'c1', message_id: 'c1', content: '清空前的消息' }))
  assert.equal(service.windows.size, 1)
  service.resetInbox('收件箱已清空')
  assert.equal(service.windows.size, 0)
  assert.equal(service.snapshot().windowCount, 0)
})

test('HTTP /action 可以调整上下文窗口并持久化', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })

  const res = makeRes()
  await service.dispatchHttp(
    makeCtx(),
    makeReq({ method: 'POST', url: '/api/dingtalk-bridge/action', body: JSON.stringify({ type: 'set-window-messages', value: 9 }) }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(service.snapshot().windowMessages, 9)
  assert.equal(service.config.windowMessages, 9)

  // 落盘后新实例读回来还是 9
  const reloaded = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  await reloaded.loadState()
  assert.equal(reloaded.config.windowMessages, 9)

  // 越界值会被夹到 2–20
  const clampHigh = makeRes()
  await service.dispatchHttp(
    makeCtx(),
    makeReq({ method: 'POST', url: '/api/dingtalk-bridge/action', body: JSON.stringify({ type: 'set-window-messages', value: 99 }) }),
    clampHigh,
  )
  assert.equal(service.config.windowMessages, 20)

  const clampLow = makeRes()
  await service.dispatchHttp(
    makeCtx(),
    makeReq({ method: 'POST', url: '/api/dingtalk-bridge/action', body: JSON.stringify({ type: 'set-window-messages', value: 1 }) }),
    clampLow,
  )
  assert.equal(service.config.windowMessages, 2)

  // 调小窗口会立刻裁剪已有窗口
  service.windows.set('dm:x', [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ direction: 'in', sender: 'x', text: `m${n}`, at: n, key: `k${n}` })))
  const shrink = makeRes()
  await service.dispatchHttp(
    makeCtx(),
    makeReq({ method: 'POST', url: '/api/dingtalk-bridge/action', body: JSON.stringify({ type: 'set-window-messages', value: 3 }) }),
    shrink,
  )
  assert.deepEqual(
    service.windows.get('dm:x').map((item) => item.text),
    ['m6', 'm7', 'm8'],
  )
})

test('parseSuggestion 支持模型返回多条 replies', () => {
  const parsed = parseSuggestion('{"reply":"第一条","replies":["第一条","第二条","第二条","第三条"],"confidence":0.9,"reason":"对方要求连发"}')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.reply, '第一条')
  assert.deepEqual(parsed.replies, ['第一条', '第二条', '第三条'])
  assert.equal(parsed.confidence, 0.9)
})

test('parseSuggestion 没有 replies 时 replies 就是单条', () => {
  const parsed = parseSuggestion('{"reply":"收到","confidence":0.8}')
  assert.deepEqual(parsed.replies, ['收到'])
  const plain = parseSuggestion('好的，我看一下')
  assert.deepEqual(plain.replies, ['好的，我看一下'])
})

test('planReplyParts 按配置决定单条还是多条', () => {
  // multiSend 关闭：永远一条（换行保留在正文里）
  assert.deepEqual(planReplyParts({ text: '第一行\n第二行', multiSend: false }), ['第一行\n第二行'])
  // 模型给了多条：按顺序拆开
  assert.deepEqual(planReplyParts({ text: '第一行', replies: ['一', '二'], max: 5 }), ['一', '二'])
  // 超过上限：截断
  assert.deepEqual(planReplyParts({ text: 'x', replies: ['1', '2', '3', '4'], max: 2 }), ['1', '2'])
  // 人工输入按换行拆
  assert.deepEqual(planReplyParts({ text: '好的\n马上办\n\n已经处理了' }), ['好的', '马上办', '已经处理了'])
  // 相邻重复与空行会被丢掉
  assert.deepEqual(planReplyParts({ text: '收到\n收到\n\n' }), ['收到'])
  // 完全没有内容
  assert.deepEqual(planReplyParts({ text: '   ' }), [])
})

test('buildSendArgs 连续多条时每条用不同的幂等键', () => {
  const record = { id: 'evt-multi', kind: 'dm', senderId: 'open-x', conversationId: 'cid-1' }
  const first = buildSendArgs({ record, body: '一' })
  const second = buildSendArgs({ record, body: '二', partIndex: 2 })
  const third = buildSendArgs({ record, body: '三', partIndex: 3, attempt: 1 })
  const keyOf = (args) => args[args.indexOf('--idempotency-key') + 1]
  assert.equal(keyOf(first), 'dsh-dingtalk-evt-multi')
  assert.equal(keyOf(second), 'dsh-dingtalk-evt-multi-p2')
  assert.equal(keyOf(third), 'dsh-dingtalk-evt-multi-p3-r2')
})

test('buildInstallArgs 拼出 npm 全局安装命令（可指定版本与源）', () => {
  assert.deepEqual(buildInstallArgs({ target: '1.0.68', registry: 'https://registry.npmmirror.com/' }), [
    'install',
    '-g',
    'dingtalk-workspace-cli@1.0.68',
    '--no-fund',
    '--no-audit',
    '--registry=https://registry.npmmirror.com/',
  ])
  // 不带版本号时安装 latest，`v` 前缀会被去掉，源为空时回退官方源。
  assert.deepEqual(buildInstallArgs({ target: 'v1.0.70', registry: '  ' }), [
    'install',
    '-g',
    'dingtalk-workspace-cli@1.0.70',
    '--no-fund',
    '--no-audit',
    '--registry=https://registry.npmjs.org/',
  ])
  assert.equal(buildInstallArgs({})[2], 'dingtalk-workspace-cli')
})

test('looksLikeMissingCommand 能识别各平台的「命令不存在」提示', () => {
  assert.equal(looksLikeMissingCommand("'dws' 不是内部或外部命令，也不是可运行的程序或批处理文件。"), true)
  assert.equal(looksLikeMissingCommand('spawn dws ENOENT'), true)
  assert.equal(looksLikeMissingCommand('bash: dws: command not found'), true)
  assert.equal(looksLikeMissingCommand('无法将“dws”项识别为 cmdlet'), true)
  // 业务错误不能被误判成「没装」。
  assert.equal(looksLikeMissingCommand('未找到已登录的钉钉组织'), false)
  assert.equal(looksLikeMissingCommand(''), false)
})

test('dws 缺失时 checkTool 把安装状态标成 missing，并给出安装提示', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), {
    dwsPath: 'dws-command-that-does-not-exist-xyz',
    autoSuggest: false,
    autoReply: false,
    dwsRegistry: 'https://registry.npmmirror.com/',
  })
  // discover:false —— 这台机器上可能真的装了 dws，这里只验「配置的路径不可用」时的判定。
  const tool = await service.checkTool({ discover: false })
  assert.equal(tool.ok, false)
  assert.equal(service.install.status, 'missing')
  assert.match(service.install.log, /未检测到 dws/)
  assert.match(service.install.log, /安装 dws/)
  assert.match(service.install.log, /registry\.npmmirror\.com/)

  const snap = service.snapshot()
  assert.equal(snap.install.status, 'missing')
  assert.equal(snap.install.currentVersion, '')
  assert.equal(snap.tool.ok, false)
})

test('自动安装记下的 dws 路径会持久化，重启后不再退回「未安装」', async () => {
  const home = await useFreshHome()
  const fakeDws = join(home, 'vendor-dws.exe')
  await writeFile(fakeDws, 'stub', 'utf8')

  const first = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  first.config.dwsPath = fakeDws
  await first.saveState()

  const second = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  assert.equal(second.config.dwsPath, 'dws')
  await second.loadState()
  assert.equal(second.config.dwsPath, fakeDws)

  // 用户显式配置了 dwsPath 时，存档不能覆盖它。
  const third = new DingTalkBridgeService(makeCtx(), { dwsPath: 'dws-custom-path', autoSuggest: false, autoReply: false })
  await third.loadState()
  assert.equal(third.config.dwsPath, 'dws-custom-path')
})

// ---- 免 npm 安装链路 ----

function makeTarEntry(name, content, mode = 0o644) {
  const body = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function makeTarball(entries) {
  const blocks = entries.map(([name, content, mode]) => makeTarEntry(name, content, mode))
  const end = Buffer.alloc(1024)
  return gzipSync(Buffer.concat([...blocks, end]))
}

test('tarballUrl 优先用元数据里的地址，缺失时按包名拼', () => {
  assert.equal(
    tarballUrl({ version: '1.0.68', dist: { tarball: 'https://example.com/x.tgz' } }),
    'https://example.com/x.tgz',
  )
  assert.equal(
    tarballUrl({ version: '1.0.68' }),
    'https://registry.npmjs.org/dingtalk-workspace-cli/-/dingtalk-workspace-cli-1.0.68.tgz',
  )
})

test('extractTarGz 解出文件并剥掉 npm 的 package/ 前缀', async () => {
  const dir = await mkdtemp(join(home, 'tar-'))
  const buffer = makeTarball([
    ['package/package.json', '{"name":"demo"}'],
    ['package/bin/run.js', 'console.log(1)', 0o755],
  ])
  const files = await extractTarGz(buffer, dir)
  assert.equal(files.length, 2)
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'demo')
  assert.ok(existsSync(join(dir, 'bin', 'run.js')))
})

test('extractTarGz 拒绝跳出目标目录的路径', async () => {
  const dir = await mkdtemp(join(home, 'tar-'))
  const buffer = makeTarball([['package/../evil.txt', 'x']])
  await assert.rejects(() => extractTarGz(buffer, dir), /路径/)
  assert.equal(existsSync(join(dirname(dir), 'evil.txt')), false)
})

test('findNode 能找到可执行的 node，安装目录落在插件数据目录下', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  const node = await service.findNode()
  assert.notEqual(node, '')
  const dir = service.runtimePackageDir()
  assert.ok(dir.endsWith(join('dws-runtime', 'node_modules', 'dingtalk-workspace-cli')))
})

test('dws 不可用时点授权会先提示安装 dws，而不是直接报命令不存在', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), {
    autoSuggest: false,
    autoReply: false,
    dwsPath: 'dws-not-installed-for-test',
  })
  await service.checkTool({ discover: false })
  const result = await service.startLogin()
  assert.equal(result.ok, false)
  assert.equal(service.snapshot().login.status, 'failed')
  assert.match(service.snapshot().login.message, /安装 dws/)
})

test('没登录钉钉时授权入口不会被「dws 未就绪」挡住', async () => {
  await useFreshHome()
  // dws 二进制可用（tool.ok=true），但还没有任何登录组织——新机器首次使用的正常状态。
  const service = new DingTalkBridgeService(makeCtx(), {
    autoSuggest: false,
    autoReply: false,
    dwsPath: 'dws-not-installed-for-test',
  })
  service.tool = { ok: true, version: '1.0.68', error: '', checkedAt: Date.now() }
  service.state.profiles = []
  service.state.loginNotice = '未找到已登录的钉钉组织，请点击右上角「钉钉授权」登录'

  const snapshot = service.snapshot()
  assert.equal(snapshot.tool.ok, true, '「没登录」不应该把 dws 标成不可用')
  assert.match(String(snapshot.loginNotice), /钉钉授权/)

  const started = await service.startLogin()
  assert.notEqual(started.error, 'dws not ready', '旧实现会在这里永久卡住用户')
  assert.ok(['pending', 'failed'].includes(service.login.status))
  await service.cancelLogin()
  assert.equal(service.login.status, 'idle')
})

test('安装步骤记录状态与耗时，结束时把没走到的步骤标成 skipped', () => {
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  service.beginInstallSteps([
    ['resolve', '读取版本信息'],
    ['download', '下载安装包'],
    ['extract', '解压安装包'],
  ])
  assert.equal(service.install.steps.length, 3)
  assert.equal(service.install.steps[0].status, 'pending')
  assert.ok(service.install.startedAt > 0)

  service.markStep('resolve', 'running', 'v1.0.68')
  service.markStep('resolve', 'done', 'v1.0.68')
  service.markStep('download', 'running', '已下载 1.2 MB')
  const steps = service.install.steps
  assert.equal(steps[0].status, 'done')
  assert.equal(steps[0].detail, 'v1.0.68')
  assert.equal(steps[1].status, 'running')
  assert.equal(steps[1].detail, '已下载 1.2 MB')
  assert.equal(steps[2].status, 'pending')

  service.finishInstallSteps(false)
  assert.equal(service.install.steps[1].status, 'error')
  assert.equal(service.install.steps[2].status, 'skipped')
  assert.ok(service.install.finishedAt > 0)
})

test('extractTarGz 支持解压进度回调', async () => {
  const dir = await mkdtemp(join(home, 'tar-progress-'))
  const seen = []
  const files = await extractTarGz(makeTarball([['package/a.txt', 'aaa']]), dir, (count) => seen.push(count))
  assert.equal(files.length, 1)
  assert.deepEqual(seen, [], '文件数不足 50 时不回调，避免刷屏')
})

test('dws 装在插件数据目录时，即使 dwsPath 丢了也能自己找回来', { skip: process.platform !== 'win32' }, async () => {
  const home = await useFreshHome()
  const vendorDir = join(home, 'integrations', 'dingtalk-bridge', 'dws-runtime', 'node_modules', 'dingtalk-workspace-cli', 'vendor')
  await mkdir(vendorDir, { recursive: true })
  const stub = join(vendorDir, 'dws.cmd')
  await writeFile(stub, '@echo off\r\necho dws version 1.0.68\r\n', 'utf8')

  const service = new DingTalkBridgeService(makeCtx(), { dwsPath: FAKE_DWS, autoSuggest: false, autoReply: false })

  // 候选清单里，插件数据目录排在「全局 node_modules」之前（先找自己装的）。
  const candidates = service.dwsCandidates()
  assert.equal(
    candidates[1],
    join(vendorDir, 'dws.exe'),
  )
  assert.equal(candidates[candidates.length - 1], 'dws')

  // 只看我们自己造的这份候选（避免真的去跑机器上已装的 dws，结果受环境影响）。
  service.dwsCandidates = () => [stub]
  const tool = await service.checkTool()

  assert.equal(tool.ok, true)
  assert.equal(tool.version, '1.0.68')
  assert.equal(service.config.dwsPath, stub)
  assert.equal(service.snapshot().dwsPath, stub)
  assert.ok(service.snapshot().dwsRuntimeDir.endsWith(join('dws-runtime', 'node_modules', 'dingtalk-workspace-cli')))

  // 找回的路径要落盘，重启后不用再找一遍。
  const saved = JSON.parse(await readFile(join(home, 'integrations', 'dingtalk-bridge', 'state.json'), 'utf8'))
  assert.equal(saved.dwsPath, stub)

  const again = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  await again.loadState()
  assert.equal(again.config.dwsPath, stub)
})

test('退出登录只清登录态，不会把 dws 说成未安装', { skip: process.platform !== 'win32' }, async () => {
  const home = await useFreshHome()
  const stub = join(home, 'fake-dws-logout.cmd')
  await writeFile(stub, '@echo off\r\nexit /b 0\r\n', 'utf8')

  const service = new DingTalkBridgeService(makeCtx(), { dwsPath: stub, autoSuggest: false, autoReply: false })
  service.tool = { ok: true, version: '1.0.68', error: '', checkedAt: Date.now() }
  service.install = { ...service.install, status: 'ready', currentVersion: '1.0.68' }
  service.state.profiles = [{ profile: 'p1', status: 'active', corpName: '星海科技', userName: '张三' }]
  service.state.selfName = '张三'
  service.stopAllListeners = async () => {}

  const result = await service.logoutAll({ quiet: true })
  const snap = service.snapshot()

  assert.equal(result.ok, true)
  // 关键：dws 依然可用，界面不该出现「dws 未就绪 / 未检测到 dws 命令」。
  assert.equal(snap.tool.ok, true)
  assert.equal(snap.tool.version, '1.0.68')
  assert.equal(snap.install.status, 'ready')
  // 登录态被清掉，并留下「请重新授权」的提示。
  assert.equal(snap.profiles.length, 0)
  assert.equal(snap.selfName, '')
  assert.match(snap.loginNotice, /已退出钉钉登录/)
})

test('模型返回 reply 为空的 JSON 时，不会把整段 JSON 当成草稿', () => {
  const raw =
    '{"reply":"","confidence":0.0,"needsHuman":true,"reason":"对方发的是图片，无法识别图片内容，缺少判断依据，需要本人查看后回复"}'
  const result = parseSuggestion(raw)
  assert.equal(result.ok, false)
  assert.equal(result.reply, '')
  assert.deepEqual(result.replies, [])
  assert.equal(result.format, 'json-empty')
  assert.equal(result.needsHuman, true)
  assert.match(result.reason, /图片/)
  // 关键：草稿里绝不能出现 JSON 片段
  assert.ok(!result.reply.includes('{'))
})

test('looksLikeJsonEnvelope 只拦「模型原始 JSON」，不误伤正常回复', () => {
  assert.equal(looksLikeJsonEnvelope('{"reply":"","confidence":0}'), true)
  assert.equal(looksLikeJsonEnvelope('  {"replies":["a"],"needsHuman":true}  '), true)
  assert.equal(looksLikeJsonEnvelope('好的，我看一下'), false)
  assert.equal(looksLikeJsonEnvelope('{"a":1}'), false)
  assert.equal(looksLikeJsonEnvelope('{不是 json}'), false)
})

test('deliver 拒绝把模型原始 JSON 发到钉钉，并给出可读错误', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  const record = {
    id: 'msg-json-body',
    kind: 'dm',
    sender: '张三',
    senderId: 'openIdZhangSan000000000000000000',
    text: '你好',
    at: Date.now(),
    status: 'suggested',
    images: [],
  }
  service.state.messages = [record]

  const ok = await service.deliver(record, '{"reply":"","confidence":0.0,"needsHuman":true,"reason":"看不见图"}')
  assert.equal(ok, false)
  assert.equal(record.status, 'failed')
  assert.equal(record.reply.ok, false)
  assert.match(record.reply.error, /原始 JSON/)
})

test('send-reply 在没有建议也没有输入时直接拒绝，不去调用 dws', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  service.state.messages = [
    {
      id: 'msg-empty-reply',
      kind: 'dm',
      sender: '张三',
      senderId: 'openIdZhangSan000000000000000000',
      text: '你好',
      at: Date.now(),
      status: 'needs-human',
      suggestion: { text: '', replies: [], ok: false, reason: '看不见图' },
    },
  ]
  const result = await service.handleAction(makeCtx(), { type: 'send-reply', id: 'msg-empty-reply', text: '' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /回复内容为空/)
})

test('喂给模型的条数跟着滑动窗口走，旧的 contextMessages 不再生效', async () => {
  await useFreshHome()
  // 故意把 contextMessages 设成 1：按老逻辑只会喂 1 条，现在应该按窗口大小 4 条走。
  const service = new DingTalkBridgeService(makeCtx(), {
    autoSuggest: false,
    windowMessages: 4,
    contextMessages: 1,
    remoteContext: false,
  })
  assert.equal(service.snapshot().contextMessages, 4)
  assert.equal(service.config.contextMessages, service.config.windowMessages)

  const base = Date.now() - 30_000
  for (let i = 1; i <= 4; i += 1) {
    service.ingest(
      'profile-1',
      dmEvent({ event_id: `w${i}`, message_id: `w${i}`, content: `第 ${i} 句`, create_time: base + i * 1000 }),
    )
  }
  const record = service.state.messages.find((item) => item.messageId === 'w4')
  const history = await service.buildHistory(record)
  assert.deepEqual(
    history.map((item) => item.text),
    ['第 1 句', '第 2 句', '第 3 句'],
  )

  // 改窗口大小后，喂给模型的条数立刻跟着变（不再是两套数字）。
  await service.handleAction(makeCtx(), { type: 'set-window-messages', value: 2 })
  assert.equal(service.snapshot().windowMessages, 2)
  assert.equal(service.snapshot().contextMessages, 2)
  const shrunk = await service.buildHistory(record)
  assert.deepEqual(
    shrunk.map((item) => item.text),
    ['第 3 句'],
  )
})

test('refreshStats 读取 npm 下载量与 GitHub 星标，并按 TTL 缓存', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('api.npmjs.org')) {
      return { ok: true, json: async () => ({ downloads: 2474 }) }
    }
    return { ok: true, json: async () => ({ stargazers_count: 6 }) }
  }
  try {
    const first = await service.refreshStats({ force: true })
    assert.equal(first.downloads, 2474)
    assert.equal(first.stars, 6)
    assert.match(first.version, /^\d+\.\d+\.\d+$/)
    assert.equal(first.error, '')
    assert.equal(calls.length, 2)

    // TTL 内再问一次不应该重新发请求（避免每帧刷新都打网络）。
    const second = await service.refreshStats()
    assert.equal(calls.length, 2)
    assert.equal(second.downloads, 2474)

    // snapshot 里带出去，界面才能渲染「vX · ↓ 2.5k · ★ 6」。
    const snapshot = service.snapshot()
    assert.equal(snapshot.stats.downloads, 2474)
    assert.equal(snapshot.stats.stars, 6)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('refreshStats 接口失败时保留上一次的数值，只记原因', async () => {
  await useFreshHome()
  const service = new DingTalkBridgeService(makeCtx(), { autoSuggest: false, autoReply: false })
  service.stats = { version: '0.4.6', downloads: 111, stars: 2, checkedAt: 0, error: '' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
  try {
    const stats = await service.refreshStats({ force: true })
    assert.equal(stats.downloads, 111)
    assert.equal(stats.stars, 2)
    assert.equal(stats.version, '0.4.6')
    assert.match(stats.error, /503/)
  } finally {
    globalThis.fetch = realFetch
  }
})

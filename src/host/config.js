import Schema from '@deepseek-ai/schemastery'

/**
 * 插件配置（在 DSH 设置面板 → 插件 → 钉钉消息自动化 中可视化编辑）。
 * 页面上的「自动回复」开关会实时覆盖 autoReply 并持久化到 state.json。
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('启用钉钉消息自动化：开启后会挂载 dws 事件监听并实时接收消息。'),

  dwsPath: Schema.string()
    .default('dws')
    .description('dws CLI 路径。默认使用 PATH 中的 dws，也可填绝对路径（如 E:\\app\\node\\dws.cmd）。'),

  dwsRegistry: Schema.string()
    .default('https://registry.npmjs.org/')
    .description('自动安装 / 更新 dws 时使用的 npm 源（只在点击「安装 dws」「更新 dws」时生效，可用国内镜像加速）。'),

  profiles: Schema.array(Schema.string())
    .default([])
    .description('要监听的组织 profile（形如 corpId:userId）。留空表示自动监听当前登录的组织。'),

  listenDirect: Schema.boolean()
    .default(true)
    .description('接收私信（单聊）消息。'),

  listenGroupAt: Schema.boolean()
    .default(true)
    .description('接收群聊中 @ 我的消息。'),

  autoReply: Schema.boolean()
    .default(false)
    .description('「自动回复」开关的初始状态。页面顶部开关可实时切换，切换后立即持久化。'),

  autoSuggest: Schema.boolean()
    .default(true)
    .description('收到消息后自动调用模型生成建议回复（关闭后需手动点「生成建议」）。'),

  minConfidence: Schema.number()
    .min(0)
    .max(1)
    .default(0.72)
    .description('自动回复的置信度阈值。模型自评低于该值、或认为需要人工判断时，改为弹框等待确认。'),

  contextMessages: Schema.number()
    .min(1)
    .max(20)
    .default(5)
    .description(
      '【已合并到 windowMessages】喂给模型的同来源历史条数。现在始终等于滑动窗口大小（窗口多大就喂多少条），填这个值不会生效，保留仅为兼容旧配置。要调上下文长度请改 windowMessages 或用收件箱顶部的「上下文窗口」下拉框。',
    ),

  windowMessages: Schema.number()
    .min(2)
    .max(20)
    .default(5)
    .description(
      '每个消息来源（私信按发送人、群 @ 按群）各自维护的滑动窗口长度，同时也是喂给模型的上下文条数。窗口只保留最近 N 条消息（含我的回复），新消息进来自动挤掉最早一条；AI 生成建议时只看本来源窗口里的内容，避免不同来源串味、也避免上下文过长。默认 5 条，范围 2–20。',
    ),

  remoteContext: Schema.boolean()
    .default(true)
    .description('生成建议回复前，先从钉钉拉取该会话最新消息作为上下文（更完整的对话历史）。关闭则只用插件本地收到的消息。'),

  remoteContextLimit: Schema.number()
    .min(0)
    .max(30)
    .default(10)
    .description('从钉钉拉取的历史消息条数（默认 10 条最新消息）。0 表示不拉取。'),

  imageRecognition: Schema.boolean()
    .default(true)
    .description('识别消息里的图片：自动下载图片，并在模型支持视觉时一并交给模型分析（需模型本身支持图片输入）。'),

  imageMax: Schema.number()
    .min(1)
    .max(4)
    .default(2)
    .description('单条消息最多下载并分析几张图片。'),

  replyPrefix: Schema.string()
    .default('')
    .description('自动回复正文前缀，例如「[AI] 」。留空表示不加。'),

  groupReplyAt: Schema.boolean()
    .default(true)
    .description(
      '群 @ 消息回复时，先在正文里 @ 回发送人，保证「谁 @ 我，我就 @ 谁」。关闭后群回复只引用发送人的话、不再 @ 他。',
    ),

  multiSend: Schema.boolean()
    .default(true)
    .description(
      '允许一次回复拆成多条消息依次发出（例如对方说「给我发 10 条消息试试」）。关闭后永远只发一条，多条内容会用换行合成一条。',
    ),

  multiSendMax: Schema.number()
    .min(1)
    .max(10)
    .default(5)
    .description('一次最多连续发几条消息（1–10，默认 5）。模型最多拆这么多条，人工输入按换行拆分也受此限制。'),

  multiSendDelayMs: Schema.number()
    .min(100)
    .max(5000)
    .default(600)
    .description('连续发送多条消息时，两条之间的间隔毫秒数（100–5000，默认 600）。间隔太小容易被钉钉限频。'),

  notifyModal: Schema.boolean()
    .default(true)
    .description('需要人工确认回复时，在 DSH 主界面弹出提示框。'),

  maxInbox: Schema.number()
    .min(20)
    .max(500)
    .default(120)
    .description('页面最多保留的消息条数，超出后丢弃最旧的记录。'),

  suggestProvider: Schema.string()
    .default('')
    .description('生成建议回复所用的模型服务（provider）。留空表示使用 DSH 当前默认模型。'),

  suggestModel: Schema.string()
    .default('')
    .description('生成建议回复所用的模型名。留空表示跟随 DSH 当前默认模型。'),

  suggestReasoningEffort: Schema.string()
    .default('')
    .description('推理强度（可选：low / medium / high）。留空使用模型默认值。'),

  suggestTimeoutMs: Schema.number()
    .min(5000)
    .max(180000)
    .default(30000)
    .description('单次生成建议回复的超时时间（毫秒）。'),

  dryRun: Schema.boolean()
    .default(false)
    .description('演练模式：只预览将要发送的内容（dws --dry-run），不会真正把消息发到钉钉。用于联调与演示。'),

  loginMode: Schema.string()
    .default('loopback')
    .description(
      '钉钉授权方式。loopback（默认）= 本机浏览器授权，点开授权页扫码即可，不需要输入任何授权码；device = 设备流，显示二维码 + 授权码，适合无浏览器的远程环境。',
    ),

  loginReset: Schema.boolean()
    .default(true)
    .description(
      '每次授权前先退出已登录的组织（dws auth logout），只保留本次新授权的组织，避免重复授权累积出多个被监听的组织。设为 false 则保留已有登录、只追加新组织。',
    ),
})

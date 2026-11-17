// 真实 dws 发送链路验证（演练模式）：走 service.deliver 完整路径，确认纯拼装出的
// 命令能被 dws 接受（不真正打扰群里的人）。
//
// 用法：node scripts/verify-send.mjs "<openConversationId>"
import { DingTalkBridgeService, buildSendArgs } from '../src/host/service.js';

const conversationId = process.argv[2] || '';
if (!conversationId) {
  console.error('用法: node scripts/verify-send.mjs "<openConversationId>"');
  process.exit(2);
}

const ctx = {
  get: (name) => {
    if (name === 'connection') return { requestRejection: () => undefined };
    if (name === 'llm') return { stream: async function* () {} };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'x', model: 'y' }) };
    return undefined;
  },
  effect: () => () => {},
  logger: { info() {}, warn() {}, debug() {}, error() {} },
};

const service = new DingTalkBridgeService(ctx, {
  enabled: true,
  dwsPath: 'dws',
  profiles: [],
  listenDirect: false,
  listenGroupAt: false,
  autoReply: false,
  autoSuggest: false,
  dryRun: true,
});

const record = {
  id: 'verify-group-1',
  messageId: 'msgVERIFYGROUP1',
  kind: 'group',
  sender: '葛春光',
  senderId: 'DZxSz9PvHH4CctQwczX6u2GDUqyKOhmkf',
  text: '（联调测试消息，请忽略）',
  conversationId,
  profile: '',
  at: Date.now(),
  status: 'received',
  suggestion: null,
  reply: null,
};

console.log('args =', JSON.stringify(buildSendArgs({ record, body: '联调测试：命令拼装校验', dryRun: true })));
await service.deliver(record, '联调测试：命令拼装校验', { auto: true });
console.log('status =', record.status);
console.log('reply  =', JSON.stringify(record.reply));
console.log('error  =', record.error || '(none)');
process.exit(record.reply && record.reply.ok ? 0 : 1);

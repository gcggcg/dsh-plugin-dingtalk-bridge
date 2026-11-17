// 验证「幂等键重复」这条报错：同一个 --idempotency-key 连发两次，
// 第二次会被钉钉拒绝；换 attempt 得到新键后就能正常发出。
// 用法：node scripts/duplicate-smoke.mjs <openDingTalkId>（默认发给自己）
import { runDws, resolveDwsCommand, parseLooseJson } from '../src/host/dws.js'
import { buildSendArgs, isDuplicateSendFailure } from '../src/host/service.js'

const target = process.argv[2] || 'openIdZhangSan000000000000000000'
const dwsPath = resolveDwsCommand('')
const record = { id: 'duplicate-smoke-1', kind: 'dm', senderId: target, profile: '' }
const stamp = new Date().toISOString().slice(11, 19)

async function send(attempt, label) {
  const args = buildSendArgs({ record, body: `${label} 幂等键验证 ${stamp}`, attempt })
  const key = args[args.indexOf('--idempotency-key') + 1]
  const result = await runDws(dwsPath, args, { timeoutMs: 45000 })
  const payload = parseLooseJson(result.stdout)
  const text = `${result.stderr}\n${result.stdout}`
  return {
    label,
    key,
    code: result.code,
    ok: result.code === 0 && !(payload && payload.ok === false),
    duplicate: isDuplicateSendFailure(text),
    error: (payload?.error?.message || payload?.error || result.stderr || '').toString().slice(0, 200),
  }
}

const first = await send(0, '第一次')
console.log('A', JSON.stringify(first, null, 2))

const again = await send(0, '重复同键')
console.log('B', JSON.stringify(again, null, 2))

const retried = await send(1, '换键重发')
console.log('C', JSON.stringify(retried, null, 2))

console.log('\n结论:')
console.log('  首次发送成功 =', first.ok)
console.log('  同键再发被判重复 =', again.duplicate)
console.log('  换键后重发成功 =', retried.ok, '(key', retried.key + ')')
process.exit(first.ok && again.duplicate && retried.ok ? 0 : 1)

// 验证 spawnDws 在 Windows 上对含空格/中文/引号的 --text 参数是否原样透传。
import { runDws } from '../src/host/dws.js'

const target = 'D7FTg3T2s4CTriiEXrnxMqIVhqzjqiiyziSii'
const samples = ['hello world', '中文 空格 测试', '带"引号"的文本', 'a&b test', '换行\n第二行']

for (const text of samples) {
  const result = await runDws(
    'dws',
    ['chat', '+messages-send', '--as', 'user', '--open-dingtalk-id', target, '--text', text, '--ai-tag=false', '--dry-run'],
    { timeoutMs: 40000 },
  )
  let content = ''
  try {
    const payload = JSON.parse(result.stdout)
    content = payload.actions?.[0]?.arguments?.content ?? ''
  } catch {
    content = `(not json) ${result.stderr.slice(0, 120)}`
  }
  let parsed = content
  try {
    parsed = JSON.parse(content).content
  } catch {
    // 保留原文
  }
  console.log(`input=${JSON.stringify(text)} -> code=${result.code} content=${JSON.stringify(parsed)}`)
}

// 授权登录冒烟：默认 loopback（本机浏览器回调，无需授权码）；loginMode=device 时回退到设备流（授权码 + 二维码）。
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dingtalk-login-smoke-'))
process.env.DSH_HOME = home

const { DingTalkBridgeService } = await import('../src/host/service.js')

const ctx = {
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }) }
    return null
  },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(service, predicate, tries = 20) {
  for (let index = 0; index < tries; index += 1) {
    const login = service.snapshot().login
    if (predicate(login)) return login
    await sleep(500)
  }
  return service.snapshot().login
}

let failed = false
const check = (label, ok, extra = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

// ---------------------------------------------------------------- loopback（默认）
{
  const service = new DingTalkBridgeService(ctx, { enabled: true, dwsPath: 'dws', autoSuggest: false })
  console.log('[login-smoke] loopback: startLogin()')
  await service.startLogin()
  const login = await waitFor(service, (item) => item.status === 'pending' && item.url !== '')
  console.log('[login-smoke] loopback status=%s mode=%s url=%s', login.status, login.mode, login.url.slice(0, 78))
  check('loopback 模式标记正确', login.mode === 'loopback')
  check('拿到授权页链接', /login\.dingtalk\.com\/oauth2\/auth/.test(login.url))
  check('链接回调到本机端口', /127\.0\.0\.1/.test(login.url))
  check('loopback 不产生授权码', login.code === '')
  check('loopback 不生成二维码', login.qr === '')
  await service.cancelLogin()
  check('取消后回到 idle', service.snapshot().login.status === 'idle')
  await service.stop?.()
}

// ---------------------------------------------------------------- device（备用）
{
  const service = new DingTalkBridgeService(ctx, { enabled: true, dwsPath: 'dws', autoSuggest: false, loginMode: 'device' })
  console.log('[login-smoke] device: startLogin()')
  await service.startLogin()
  const login = await waitFor(service, (item) => item.status === 'pending' && item.code !== '')
  const withQr = await waitFor(service, (item) => item.qr !== '', 6)
  console.log('[login-smoke] device status=%s code=%s qr长度=%s', withQr.status, withQr.code, withQr.qr.length)
  check('device 模式标记正确', login.mode === 'device')
  check('解析出授权码', /^[A-Z0-9-]+$/.test(login.code), login.code)
  check('生成二维码 dataURL', withQr.qr.startsWith('data:image/png;base64,'))
  await service.cancelLogin()
  check('取消后清空二维码', service.snapshot().login.qr === '')
  await service.stop?.()
}

console.log(failed ? '[login-smoke] 存在失败断言 ❌' : '[login-smoke] 全部断言通过 ✅')
process.exit(failed ? 1 : 0)

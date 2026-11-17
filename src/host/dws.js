import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, dirname } from 'node:path'

/**
 * dws CLI 的最小封装：
 *  - Windows 上 dws 是 .cmd 包装脚本：优先解析出它内部的 node 入口脚本，直接用 node 启动，
 *    彻底绕开 cmd.exe 的参数引用问题（含空格的中文回复文本会被 cmd 拆断）；
 *  - 解析失败时退回 cmd.exe /c 方式；
 *  - 统一 UTF-8 代码页，输出解码带 GBK 兜底；
 *  - 提供行读取器（dws event consume 的 NDJSON 流）与宽松 JSON 解析。
 */

/** 把子进程输出块解码为文本，UTF-8 优先，非法序列回退 GBK。 */
export function toText(chunk) {
  if (typeof chunk === 'string') return chunk
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(chunk)
  } catch {
    try {
      return new TextDecoder('gbk').decode(chunk)
    } catch {
      return Buffer.from(chunk).toString('utf8')
    }
  }
}

/** 解析实际执行的命令：留空即 `dws`。 */
export function resolveDwsCommand(configured) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  return value === '' ? 'dws' : value
}

/** 在 PATH 里找可执行文件（含 PATHEXT 后缀），找不到返回 ''。 */
function whichSync(command) {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : ''
  }
  const pathValue = process.env.PATH || process.env.Path || ''
  // Windows 上同名文件可能同时有 `dws`（bash 垫片）与 `dws.cmd`，必须优先 .cmd/.exe。
  const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (dir.trim() === '') continue
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/**
 * 若目标是 npm/pnpm 生成的 .cmd 垫片，解析出真正的 node 入口脚本，
 * 这样可以直接 spawn(node, [script, ...args])，参数原文透传不再经过 cmd.exe。
 * @returns {{command:string, prefix:string[]} | null}
 */
function resolveNodeShim(command) {
  if (process.platform !== 'win32') return null
  const target = whichSync(command)
  if (target === '' || !/\.(cmd|bat)$/i.test(target)) return null
  let text = ''
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    return null
  }
  // 匹配 "%dp0%\path\to\entry.js" 或 "%~dp0\entry.js" 这类写法。
  const match = /"?%[~]?dp0%?\\?([^"\r\n]+?\.(?:js|mjs|cjs))"?/.exec(text)
  if (!match) return null
  const scriptPath = join(dirname(target), match[1])
  if (!existsSync(scriptPath)) return null
  const siblingNode = join(dirname(target), 'node.exe')
  const nodePath = existsSync(siblingNode) ? siblingNode : process.execPath
  return { command: nodePath, prefix: [scriptPath] }
}

/** cmd.exe 单参数引用：含空格或特殊字符时用双引号包裹，内层引号按 cmd 规则转义为 \"。 */
function quoteForCmd(value) {
  const text = String(value)
  if (text === '') return '""'
  if (!/[\s"&|<>^]/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

/** 规范化参数列表（数组或对象展开后的形式）。 */
export function normalizeArgs(args) {
  if (Array.isArray(args)) return args.map((item) => String(item))
  if (args && typeof args === 'object') {
    const out = []
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null || value === false) continue
      if (value === true) out.push(key)
      else if (Array.isArray(value)) out.push(key, value.map((v) => String(v)).join(','))
      else out.push(key, String(value))
    }
    return out
  }
  return []
}

/** 启动 dws 子进程（不等待）。 */
export function spawnDws(command, args, options = {}) {
  const resolved = resolveDwsCommand(command)
  const argv = normalizeArgs(args)
  const env = { ...process.env, ...(options.env || {}) }
  const spawnOptions = {
    env,
    windowsHide: true,
    stdio: [options.stdin === false ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    cwd: options.cwd || process.cwd(),
  }

  if (process.platform === 'win32' && !/\.exe$/i.test(resolved)) {
    // 首选：直接跑 .cmd 垫片背后的 node 入口，参数原样透传（含空格的中文不会丢）。
    const shim = resolveNodeShim(resolved)
    if (shim) return spawn(shim.command, [...shim.prefix, ...argv], spawnOptions)

    const line = [quoteForCmd(resolved), ...argv.map(quoteForCmd)].join(' ')
    const shell = process.env.ComSpec || 'cmd.exe'
    return spawn(shell, ['/d', '/s', '/c', `chcp 65001>nul & ${line}`], spawnOptions)
  }

  return spawn(resolved, argv, spawnOptions)
}

/** 结束进程树（Windows 必须走 taskkill，否则 dws 的子进程会成为孤儿）。 */
export function killTree(child) {
  if (!child || child.killed === true || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && Number.isFinite(child.pid)) {
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /pid ${child.pid} /T /F`], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return
    }
    child.kill('SIGTERM')
  } catch {
    // 进程可能已经退出，忽略。
  }
}

/**
 * 执行一次 dws 命令并收集输出。
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, error?:string}>}
 */
export function runDws(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000

  return new Promise((resolve) => {
    let child
    try {
      child = spawnDws(command, args, options)
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: String(error?.message || error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      finish(null)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += toText(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += toText(chunk)
    })
    child.on('error', (error) => {
      stderr += `\n${String(error?.message || error)}`
      finish(null)
    })
    child.on('close', (code) => {
      finish(code)
    })

    // dws 的交互式命令（如 device flow）不会读 stdin，这里直接关闭避免挂起。
    try {
      child.stdin?.end()
    } catch {
      // 忽略。
    }
  })
}

/** 逐行切分流式输出（dws event consume -f ndjson）。 */
export function createLineReader(onLine) {
  let buffer = ''

  return {
    push(chunk) {
      buffer += chunk
      while (true) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim() !== '') {
          try {
            onLine(line)
          } catch {
            // 单行处理失败不影响后续消息。
          }
        }
      }
    },
    flush() {
      const line = buffer.trim()
      buffer = ''
      if (line !== '') {
        try {
          onLine(line)
        } catch {
          // 忽略。
        }
      }
    },
  }
}

/** 宽松 JSON 解析：忽略日志前缀，截取首个 `{` 到末个 `}`。 */
export function parseLooseJson(text) {
  const raw = typeof text === 'string' ? text : ''
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 从命令输出里取一段可读的错误信息。 */
export function describeFailure(result) {
  const payload = parseLooseJson(result?.stdout) || parseLooseJson(result?.stderr)
  const candidates = [
    payload?.error?.message,
    payload?.message,
    typeof payload?.error === 'string' ? payload.error : '',
    (result?.stderr || '').trim(),
    (result?.stdout || '').trim(),
  ]
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim() !== '') {
      return item.trim().split('\n').slice(-6).join('\n')
    }
  }
  if (result?.timedOut) return 'dws 命令执行超时'
  return `dws 命令退出码 ${result?.code}`
}

/** device flow 输出解析（登录引导用，保留与参考插件一致的容错）。 */
export function parseDeviceFlow(output) {
  const text = typeof output === 'string' ? output : ''
  const code = /授权码[:：]\s*([A-Z0-9-]+)/i.exec(text)?.[1] || ''
  const url =
    /(https?:\/\/[^\s]*login\.dingtalk\.com[^\s]*)/i.exec(text)?.[1] ||
    /(https?:\/\/[^\s]*open-dev\.dingtalk\.com[^\s]*)/i.exec(text)?.[1] ||
    ''
  if (code === '' && url === '') return null
  return { code, url }
}

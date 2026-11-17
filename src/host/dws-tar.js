import { gunzipSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

const BLOCK = 512

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

// pax 扩展头里每条记录是 "<长度> key=value\n"，这里只关心 path / linkpath。
function parsePax(data) {
  const out = {}
  let index = 0
  while (index < data.length) {
    const space = data.indexOf(0x20, index)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(index, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(space + 1, index + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1)
    index += length
  }
  return out
}

// 统一用 POSIX 分隔符处理（Windows 的 normalize 会把 / 变成 \，那样就剥不掉 package/ 前缀了）。
// 含 `..` 的路径一律拒绝：正常的 npm tarball 不会有，出现就说明包被动过。
function safeRelativePath(raw) {
  const cleaned = String(raw).replace(/\\/g, '/')
  const parts = cleaned.split('/')
  if (parts.includes('..')) throw new Error(`压缩包里有非法路径：${raw}`)
  const trimmed = parts.filter((part) => part !== '' && part !== '.')
  return trimmed.join('/')
}

/**
 * 解压 npm 包 tarball（.tgz）到 destDir。纯 Node 实现，不依赖 npm / tar。
 * npm 包里的顶层目录通常是 `package/`，这里会把 `package/` 前缀剥掉，
 * 让调用方拿到 `<destDir>/package.json`、`<destDir>/install.js` 这样的结构。
 */
export async function extractTarGz(buffer, destDir, onProgress) {
  const tar = gunzipSync(buffer)
  let offset = 0
  let pendingPath = ''
  let pendingLink = ''
  let longName = ''
  const written = []
  const report = typeof onProgress === 'function' ? onProgress : null

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break

    const type = String.fromCharCode(header[156] || 0x30)
    const size = readOctal(header, 124, 12)
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const dataStart = offset + BLOCK
    const data = tar.subarray(dataStart, dataStart + size)
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'x') {
      const pax = parsePax(data)
      if (pax.path) pendingPath = pax.path
      if (pax.linkpath) pendingLink = pax.linkpath
      offset = next
      continue
    }
    if (type === 'g' || type === 'L') {
      if (type === 'L') longName = readString(data, 0, data.length)
      offset = next
      continue
    }

    const rawName = longName || pendingPath || (prefix ? `${prefix}/${name}` : name)
    longName = ''
    pendingPath = ''
    pendingLink = ''

    const relative = safeRelativePath(rawName)
    offset = next
    if (relative === '') continue

    const withoutPackage = relative.startsWith('package/') ? relative.slice('package/'.length) : relative
    if (withoutPackage === '') continue
    const target = join(destDir, ...withoutPackage.split('/'))

    if (type === '5') {
      await mkdir(target, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\u0000' && type !== '7') continue

    await mkdir(dirname(target), { recursive: true })
    // 保持可执行位，install.js / bin 脚本才能直接跑。
    const mode = readOctal(header, 100, 8)
    await writeFile(target, data, { mode: mode > 0 ? mode : 0o644 })
    written.push(withoutPackage)
    if (report && written.length % 50 === 0) report(written.length)
  }

  return written
}

/** 从 npm registry 的元数据里挑出 tarball 地址。 */
export function tarballUrl(meta, fallbackName = 'dingtalk-workspace-cli') {
  if (!meta || typeof meta !== 'object') return ''
  const version = typeof meta.version === 'string' ? meta.version : ''
  const dist = meta.dist && typeof meta.dist === 'object' ? meta.dist : null
  if (dist && typeof dist.tarball === 'string' && dist.tarball !== '') return dist.tarball
  if (version === '') return ''
  return `https://registry.npmjs.org/${fallbackName}/-/${fallbackName}-${version}.tgz`
}

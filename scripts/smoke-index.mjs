// index.js 契约冒烟：校验 apply() 在真实 DSH 宿主形状下能创建服务并注册路由，
// 且 Config schema 能校验 cordis.patch.yml 里的默认配置。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as plugin from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');

let routeRegistration = null;
let effectDisposerCount = 0;
const cleanups = [];

const fakeCtx = {
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined };
    return undefined;
  },
  effect(factory) {
    effectDisposerCount += 1;
    const dispose = factory();
    cleanups.push(dispose);
    return () => {};
  },
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  webServer: {
    register(definition) {
      routeRegistration = definition;
      return () => {};
    },
  },
};

// 1. Config 校验 patch 文件里的默认配置
const patchText = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8');
if (!/^\s*-\s*insert:/m.test(patchText)) throw new Error('cordis.patch.yml 缺少 - insert: 入口');
if (!patchText.includes('dsh-plugin-dingtalk-bridge')) throw new Error('cordis.patch.yml 缺少包名');
if (!patchText.includes('id: dingtalk-bridge')) throw new Error('cordis.patch.yml 缺少 row id');

const defaults = {
  enabled: true,
  listenDirect: true,
  listenGroupAt: true,
  autoReply: false,
  autoSuggest: true,
  minConfidence: 0.72,
  contextMessages: 6,
  dryRun: false,
};
const validated = plugin.Config(defaults);
console.log('[smoke] Config 校验通过:', JSON.stringify({ dryRun: validated.dryRun, minConfidence: validated.minConfidence }));

let rejected = false;
try {
  plugin.Config({ minConfidence: 5 });
} catch (error) {
  rejected = true;
  console.log('[smoke] 越界配置被拒绝:', String(error.message).split('\n')[0]);
}
if (!rejected) throw new Error('minConfidence 越界未被拒绝');

// 2. apply() 形状
if (plugin.name !== 'dingtalk-bridge') throw new Error(`name 不符: ${plugin.name}`);
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('webServer')) throw new Error('inject 缺少 webServer');
plugin.apply(fakeCtx, plugin.Config(defaults));

if (!routeRegistration) throw new Error('apply() 未注册 HTTP 路由');
console.log('[smoke] 路由注册:', JSON.stringify({ kind: routeRegistration.kind, path: routeRegistration.path }));
if (routeRegistration.kind !== 'prefix') throw new Error('路由 kind 应为 prefix');
if (routeRegistration.path !== '/api/dingtalk-bridge') throw new Error(`路由前缀不符: ${routeRegistration.path}`);
if (typeof routeRegistration.handler !== 'function') throw new Error('路由 handler 不是函数');
if (effectDisposerCount !== 2) throw new Error(`ctx.effect 调用次数应为 2，实际 ${effectDisposerCount}`);

// 3. 清理（逆向执行 effect dispose，确保 stop() 路径不抛）
for (const dispose of cleanups.reverse()) {
  if (typeof dispose === 'function') await dispose();
}
console.log('[smoke] 清理完成，全部断言通过 ✅');

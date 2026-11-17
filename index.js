/**
 * 钉钉消息自动化 —— 宿主侧入口。
 *
 * 职责：
 *  - 注册 /api/dingtalk-bridge 路由前缀（state / events(SSE) / action）；
 *  - 启动 DingTalkBridgeService：按组织 profile 挂载 dws 事件监听，
 *    实时接收私信与群 @ 消息，按发送人记录来源，生成建议回复并按开关自动回复。
 */

export const name = 'dingtalk-bridge'

export const inject = ['webServer']

export { Config } from './src/host/config.js'

import { DingTalkBridgeService } from './src/host/service.js'

const ROUTE_PREFIX = '/api/dingtalk-bridge'

export function apply(ctx, config) {
  const service = new DingTalkBridgeService(ctx, config)

  ctx.effect(
    () => service.start(),
    'dingtalk-bridge: service lifecycle',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => service.handleHttp(ctx, req, res),
      }),
    'dingtalk-bridge: http routes',
  )
}

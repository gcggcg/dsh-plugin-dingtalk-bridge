/**
 * 钉钉消息自动化 —— Web 客户端。
 *
 * 槽位：
 *  - sidebar.panellist : 侧边栏图标入口
 *  - main              : 收件箱页面（自动回复开关 / 消息卡片 / 逐条建议回复）
 *  - shell.overlay     : 全局待确认弹框（「有 xxx 发送的 xxx 消息」）
 *  - settings.section  : 设置页说明
 *  - plugins.bundle.config : 插件配置卡片
 *
 * 实时链路：宿主 /api/dingtalk-bridge/events 的 SSE 推送，断线后自动重连并降级为轮询。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-dingtalk-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const API = '/api/dingtalk-bridge'
    const PACKAGE_NAME = 'dsh-plugin-dingtalk-bridge'
    const PANEL_KEY = 'dingtalk-inbox'
    const POLL_MS = 5000
    const SOFT_POLL_MS = 30000
    // 与 package.json 的 version 保持一致：宿主上报的 build 前缀对不上，说明 DSH 还在跑旧宿主代码。
    const CLIENT_BUILD = '0.3.7'
    // 源码仓库（GitHub）：Star 与 Issue 入口都指向这里
    const REPO_URL = 'https://github.com/gcggcg/dsh-plugin-dingtalk-bridge'
    const ISSUES_URL = `${REPO_URL}/issues`
    const NPM_URL = 'https://www.npmjs.com/package/dsh-plugin-dingtalk-bridge'

    function openExternal(url) {
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        // 浏览器拦截弹窗时退化为同页跳转
        try {
          window.location.href = url
        } catch (ignored) {
          /* 忽略：无 window 环境（测试） */
        }
      }
    }

    // ------------------------------------------------------------------ 设计令牌

    const C = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f5f6f8)',
      overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
      border1: 'var(--dsw-alias-border-l1, #ececf0)',
      border2: 'var(--dsw-alias-border-l2, #dcdee4)',
      brand: 'var(--dsw-alias-brand-primary, #2e7cf6)',
      text: 'var(--dsw-alias-label-primary, #1b1e23)',
      sub: 'var(--dsw-alias-label-secondary, #6b7280)',
      error: 'var(--dsw-alias-state-error-primary, #e5484d)',
      idle: 'var(--dsw-alias-state-idle-primary, #9aa0aa)',
      success: 'var(--dsw-alias-state-success-primary, #12a150)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      sidebarFill: 'var(--dsw-specific-sidebar-fill, #f7f8fa)',
    }

    const STYLES = `
.dsh-dt-root{height:100%;display:flex;flex-direction:column;background:${C.bg};color:${C.text};
  font-family:inherit;font-size:13px;overflow:hidden;letter-spacing:.2px}
.dsh-dt-header{display:flex;align-items:center;gap:12px;padding:14px 20px 12px;border-bottom:1px solid ${C.border1};
  background:linear-gradient(180deg, rgba(46,124,246,.045), rgba(46,124,246,0))}
.dsh-dt-title{font-size:15px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.dsh-dt-sub{font-size:11.5px;color:${C.sub};display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap}
.dsh-dt-spacer{flex:1}
.dsh-dt-footnote{font-size:11.5px;color:${C.sub};opacity:.85;white-space:nowrap}
.dsh-dt-links{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:14px;padding-top:12px;
  border-top:1px dashed ${C.border1};font-size:12px;color:${C.sub}}
.dsh-dt-links a{color:${C.brand};text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.dsh-dt-links a:hover{text-decoration:underline}
.dsh-dt-toolbar{display:flex;align-items:center;gap:10px;padding:10px 20px;flex-wrap:wrap;
  border-bottom:1px solid ${C.border1};background:${C.bg}}
.dsh-dt-tabs{display:flex;gap:2px;padding:2px;background:${C.layer2};border-radius:9px;border:1px solid ${C.border1}}
.dsh-dt-tab{appearance:none;border:0;background:transparent;color:${C.sub};font:inherit;font-size:12px;
  padding:5px 10px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:.14s}
.dsh-dt-tab:hover{color:${C.text}}
.dsh-dt-tab[data-active="1"]{background:${C.layer1};color:${C.text};box-shadow:0 1px 2px rgba(16,24,40,.1);font-weight:600}
.dsh-dt-count{font-size:10px;min-width:16px;text-align:center;padding:0 4px;border-radius:999px;
  background:rgba(46,124,246,.12);color:${C.brand};line-height:15px}
.dsh-dt-search{flex:1;min-width:130px;display:flex;align-items:center;gap:6px;padding:0 10px;height:32px;
  border:1px solid ${C.border1};border-radius:9px;background:${C.layer2};transition:.15s}
.dsh-dt-search:focus-within{border-color:${C.brand};background:${C.layer1};box-shadow:0 0 0 3px rgba(46,124,246,.12)}
.dsh-dt-search input{flex:1;border:0;outline:0;background:transparent;color:${C.text};font:inherit;font-size:12.5px}
.dsh-dt-autocfg{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:12px 20px 0;padding:12px 14px;border-radius:13px;
  border:1px solid ${C.border1};background:linear-gradient(135deg, rgba(46,124,246,.08), rgba(23,176,240,.05));
  transition:.16s}
.dsh-dt-autocfg[data-on="1"]{border-color:rgba(46,124,246,.4);box-shadow:0 4px 18px rgba(46,124,246,.12)}
.dsh-dt-autocfg-title{font-size:12.8px;font-weight:620;display:flex;align-items:center;gap:7px}
.dsh-dt-autocfg-desc{font-size:11.5px;color:${C.sub};margin-top:3px;line-height:1.5}
.dsh-dt-autocfg-extra{width:100%;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:11px;padding-top:11px;
  border-top:1px dashed ${C.border2}}
.dsh-dt-range{-webkit-appearance:none;appearance:none;width:168px;height:20px;background:transparent;
  outline:none;cursor:pointer;padding:0;margin:0}
.dsh-dt-range::-webkit-slider-runnable-track{height:5px;border-radius:99px;background:${C.border2}}
.dsh-dt-range::-moz-range-track{height:5px;border-radius:99px;background:${C.border2}}
.dsh-dt-range:disabled{opacity:.45;cursor:default}
.dsh-dt-range::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;margin-top:-5px;
  background:${C.brand};border:2px solid ${C.layer1};box-shadow:0 1px 4px rgba(16,24,40,.28)}
.dsh-dt-range::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:${C.brand};
  border:2px solid ${C.layer1};box-shadow:0 1px 4px rgba(16,24,40,.28)}
.dsh-dt-range:active::-webkit-slider-thumb{width:17px;height:17px;margin-top:-6px;
  box-shadow:0 2px 8px rgba(16,24,40,.34)}
.dsh-dt-range:active::-moz-range-thumb{width:15px;height:15px}
.dsh-dt-range:focus-visible{box-shadow:0 0 0 3px rgba(46,124,246,.22);border-radius:99px}
.dsh-dt-ticks{display:flex;justify-content:space-between;width:168px;font-size:10px;color:${C.sub};opacity:.7;
  font-variant-numeric:tabular-nums;margin-top:-2px}
.dsh-dt-select{appearance:none;-webkit-appearance:none;font-size:12px;line-height:18px;padding:4px 24px 4px 9px;
  border-radius:8px;border:1px solid ${C.border1};background:${C.bg} url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888f9c' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 8px center;
  color:${C.text};font-variant-numeric:tabular-nums;cursor:pointer;transition:border-color .15s}
.dsh-dt-select:hover{border-color:${C.border2}}
.dsh-dt-select:focus-visible{outline:none;border-color:${C.brand};box-shadow:0 0 0 3px rgba(46,124,246,.18)}
.dsh-dt-conf{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:1px 8px;border-radius:999px;
  border:1px solid transparent;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-dt-conf[data-tone="high"]{color:${C.success};background:rgba(18,161,80,.1);border-color:rgba(18,161,80,.25)}
.dsh-dt-conf[data-tone="mid"]{color:${C.warn};background:rgba(245,165,36,.12);border-color:rgba(245,165,36,.3)}
.dsh-dt-conf[data-tone="low"]{color:${C.error};background:rgba(229,72,77,.1);border-color:rgba(229,72,77,.26)}
.dsh-dt-imgs{display:flex;flex-wrap:wrap;gap:8px;margin:9px 0 2px}
.dsh-dt-img{width:104px;height:104px;border-radius:10px;border:1px solid ${C.border1};background:${C.layer2};
  display:flex;align-items:center;justify-content:center;overflow:hidden;text-decoration:none;
  font-size:11px;color:${C.sub};transition:border-color .14s,transform .14s}
.dsh-dt-img img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-dt-img:hover{border-color:${C.brand};transform:translateY(-1px)}
.dsh-dt-img[data-state="failed"]{color:${C.error};border-style:dashed}
.dsh-dt-qr{width:150px;height:150px;border-radius:12px;background:#fff;border:1px solid ${C.border1};padding:7px;
  display:block;margin:0 auto}
.dsh-dt-qrwrap{display:flex;flex-direction:column;align-items:center;gap:7px;width:100%}
.dsh-dt-auth{display:flex;gap:11px;align-items:flex-start;padding:13px;border-radius:12px;background:${C.layer2};
  border:1px solid ${C.border1}}
.dsh-dt-auth-icon{width:26px;height:26px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;
  justify-content:center;font-size:13px;font-weight:700;color:#fff;background:${C.brand}}
.dsh-dt-modelchip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 9px;border-radius:8px;
  background:${C.layer2};border:1px solid ${C.border1};color:${C.sub};max-width:100%;overflow:hidden}
.dsh-dt-modelchip b{color:${C.text};font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-dt-modal-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:21px;letter-spacing:4px;
  font-weight:700;padding:13px 10px;border-radius:12px;background:${C.layer2};border:1px dashed ${C.border2};
  color:${C.text};text-align:center;user-select:all}
.dsh-dt-modal-link{font-size:11.5px;color:${C.brand};word-break:break-all;text-decoration:none;line-height:1.5}
.dsh-dt-sources{display:flex;align-items:center;gap:7px;padding:10px 20px 2px;overflow:hidden;flex-wrap:nowrap}
.dsh-dt-src{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:11.5px;padding:4px 9px;
  border-radius:999px;border:1px solid ${C.border1};background:${C.layer1};color:${C.sub};cursor:pointer;transition:.14s;
  max-width:220px;overflow:hidden;text-overflow:ellipsis}
.dsh-dt-src:hover{border-color:${C.border2};color:${C.text}}
.dsh-dt-src[data-active="1"]{border-color:${C.brand};color:${C.brand};background:rgba(46,124,246,.08);font-weight:600}
.dsh-dt-src[data-more="1"]{border-style:dashed;color:${C.brand};border-color:rgba(46,124,246,.4);background:rgba(46,124,246,.05)}
.dsh-dt-srcname{overflow:hidden;text-overflow:ellipsis}
.dsh-dt-srcpanel{margin:8px 20px 10px;padding:10px 12px 12px;border:1px solid ${C.border1};border-radius:12px;
  background:${C.layer2};display:flex;flex-direction:column;gap:9px}
.dsh-dt-srcpanel-head{display:flex;align-items:center;gap:8px;font-size:11.5px;color:${C.sub}}
.dsh-dt-srcpanel-body{display:flex;flex-wrap:wrap;gap:7px;max-height:126px;overflow-y:auto;padding-right:2px}
.dsh-dt-srcsearch{flex:1;min-width:120px;font-size:11.5px;padding:4px 9px;border-radius:8px;
  border:1px solid ${C.border1};background:${C.layer1};color:${C.text};outline:none}
.dsh-dt-srcsearch:focus{border-color:${C.brand}}
.dsh-dt-notice{margin:0 20px 8px;padding:8px 12px;border-radius:10px;border:1px dashed ${C.border2};
  background:${C.layer2};color:${C.sub};font-size:12px;display:flex;align-items:center;gap:6px}
.dsh-dt-install{margin:0 20px 12px;padding:12px 14px;border-radius:12px;display:flex;align-items:flex-start;gap:11px;
  border:1px solid rgba(217,119,6,.32);background:rgba(217,119,6,.07)}
.dsh-dt-install[data-tone="error"]{border-color:rgba(220,38,38,.32);background:rgba(220,38,38,.07)}
.dsh-dt-install[data-tone="busy"]{border-color:rgba(31,111,235,.3);background:rgba(31,111,235,.06)}
.dsh-dt-install-icon{font-size:16px;line-height:22px;flex:none}
.dsh-dt-install-title{font-size:13px;font-weight:600;color:${C.text};letter-spacing:.2px}
.dsh-dt-install-body{margin-top:4px;font-size:12.3px;line-height:1.6;color:${C.sub};word-break:break-word}
.dsh-dt-install-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsh-dt-install-log{margin-top:6px;font-size:12px;color:${C.sub}}
.dsh-dt-install-log summary{cursor:pointer;color:${C.brand}}
.dsh-dt-install-log pre{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:${C.layer2};
  border:1px solid ${C.border1};font-size:11.5px;line-height:1.5;max-height:180px;overflow:auto;white-space:pre-wrap}
.dsh-dt-listbox{margin:0 20px 16px;border:1px solid ${C.border1};border-radius:14px;background:${C.layer1};
  box-shadow:0 1px 2px rgba(16,24,40,.04);display:flex;flex-direction:column;
  height:calc(100vh - 330px);min-height:340px;max-height:900px;overflow:hidden}
.dsh-dt-listbox[data-empty="1"]{background:transparent;border-style:dashed;box-shadow:none}
.dsh-dt-helpbox{margin:12px 20px 16px;border:1px solid ${C.border1};border-radius:14px;background:${C.layer1};
  box-shadow:0 1px 2px rgba(16,24,40,.04);height:calc(100vh - 430px);min-height:320px;max-height:1000px;
  overflow-y:auto;padding:0 16px 18px}
.dsh-dt-helpbox::-webkit-scrollbar{width:9px}
.dsh-dt-helpbox::-webkit-scrollbar-thumb{background:${C.border2};border-radius:6px;border:2px solid ${C.layer1}}
.dsh-dt-helpbox::-webkit-scrollbar-track{background:transparent}
.dsh-dt-helphead{display:flex;align-items:center;gap:9px;position:sticky;top:0;z-index:2;
  padding:12px 0 10px;background:${C.layer1};border-bottom:1px solid ${C.border1}}
.dsh-dt-help{display:flex;flex-direction:column;gap:15px;margin-top:14px}
.dsh-dt-helpsteps{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px}
.dsh-dt-helpstep{padding:11px 13px;border-radius:11px;border:1px solid ${C.border1};background:${C.layer2}}
.dsh-dt-stephead{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:${C.text}}
.dsh-dt-stephead i{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;
  border-radius:50%;font-style:normal;font-size:10.5px;font-weight:700;color:#fff;background:${C.brand};flex:none}
.dsh-dt-stepbody{margin-top:6px;font-size:12.5px;line-height:1.65;color:${C.sub}}
.dsh-dt-helpgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:10px}
.dsh-dt-helpitem{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:11px;
  border:1px solid ${C.border1};background:${C.layer2}}
.dsh-dt-helptag{font-size:11px;font-weight:700;color:${C.brand};background:rgba(46,124,246,.1);
  border:1px solid rgba(46,124,246,.2);border-radius:7px;padding:2px 7px;white-space:nowrap;line-height:16px;flex:none}
.dsh-dt-list{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:11px}
.dsh-dt-list::-webkit-scrollbar{width:9px}
.dsh-dt-list::-webkit-scrollbar-thumb{background:${C.border2};border-radius:6px;border:2px solid ${C.layer1}}
.dsh-dt-list::-webkit-scrollbar-track{background:transparent}
.dsh-dt-card{position:relative;background:${C.layer1};border:1px solid ${C.border1};border-radius:14px;
  padding:13px 15px 14px;transition:box-shadow .16s,border-color .16s}
.dsh-dt-card:hover{box-shadow:0 8px 24px rgba(16,24,40,.075);border-color:${C.border2}}
.dsh-dt-card[data-tone="warn"]{border-color:rgba(245,165,36,.45);background:
  linear-gradient(180deg, rgba(245,165,36,.06), rgba(255,255,255,0) 60%),${C.layer1}}
.dsh-dt-card[data-tone="success"]{border-color:rgba(18,161,80,.28)}
.dsh-dt-card[data-tone="error"]{border-color:rgba(229,72,77,.35)}
.dsh-dt-row{display:flex;align-items:center;gap:9px}
.dsh-dt-avatar{width:30px;height:30px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:12.5px;font-weight:650;letter-spacing:.3px;box-shadow:0 2px 8px rgba(16,24,40,.14)}
.dsh-dt-sender{font-size:13px;font-weight:640;line-height:1.2}
.dsh-dt-meta{font-size:11px;color:${C.sub};display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
.dsh-dt-badge{font-size:10.5px;line-height:16px;padding:0 7px;border-radius:999px;border:1px solid transparent;
  white-space:nowrap;font-weight:600}
.dsh-dt-badge[data-tone="brand"]{background:rgba(46,124,246,.12);color:${C.brand};border-color:rgba(46,124,246,.2)}
.dsh-dt-badge[data-tone="warn"]{background:rgba(245,165,36,.14);color:#b0730a;border-color:rgba(245,165,36,.3)}
.dsh-dt-badge[data-tone="success"]{background:rgba(18,161,80,.12);color:${C.success};border-color:rgba(18,161,80,.22)}
.dsh-dt-badge[data-tone="error"]{background:rgba(229,72,77,.12);color:${C.error};border-color:rgba(229,72,77,.24)}
.dsh-dt-badge[data-tone="idle"]{background:${C.layer2};color:${C.sub};border-color:${C.border1}}
.dsh-dt-text{margin:9px 0 0;font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word;color:${C.text}}
.dsh-dt-quote{margin-top:8px;padding:7px 10px;border-left:3px solid ${C.border2};border-radius:0 8px 8px 0;
  background:${C.layer2};color:${C.sub};font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dsh-dt-replybox{margin-top:10px;padding:9px 11px;border-radius:10px;background:rgba(18,161,80,.07);
  border:1px solid rgba(18,161,80,.2);font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dsh-dt-replybox[data-fail="1"]{background:rgba(229,72,77,.07);border-color:rgba(229,72,77,.24);color:${C.error}}
.dsh-dt-replybox[data-duplicate="1"]{background:rgba(217,119,6,.09);border-color:rgba(217,119,6,.28);color:#a15c07}
.dsh-dt-at{display:inline-block;margin-right:5px;padding:0 6px;border-radius:6px;background:rgba(31,111,235,.12);
  color:${C.brand};font-size:11.5px;font-weight:600;line-height:18px;vertical-align:1px}
.dsh-dt-multi{color:${C.brand};font-weight:600}
.dsh-dt-parts{display:flex;flex-direction:column;gap:4px;margin-top:5px}
.dsh-dt-part{display:flex;gap:7px;align-items:flex-start;font-size:12.5px;line-height:1.6}
.dsh-dt-partno{flex:none;min-width:16px;height:16px;border-radius:5px;background:rgba(31,111,235,.12);color:${C.brand};
  font-size:10.5px;font-weight:600;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
.dsh-dt-composer{display:flex;gap:8px;align-items:center;margin-top:10px}
.dsh-dt-ghostwrap{position:relative;flex:1;min-width:0}
.dsh-dt-ghost{position:absolute;inset:1px;display:flex;align-items:center;padding:0 46px 0 12px;pointer-events:none;
  overflow:hidden;white-space:pre;font-size:13px;line-height:20px;color:${C.idle};opacity:.95;z-index:2;
  text-shadow:0 1px 0 rgba(255,255,255,.65)}
.dsh-dt-input{width:100%;box-sizing:border-box;height:38px;padding:0 12px;font:inherit;font-size:13px;line-height:20px;
  border-radius:10px;border:1px solid ${C.border2};background:${C.bg};color:${C.text};outline:none;
  transition:border-color .15s,box-shadow .15s}
.dsh-dt-input::placeholder{color:${C.idle}}
.dsh-dt-input:focus{border-color:${C.brand};box-shadow:0 0 0 3px rgba(46,124,246,.14)}
.dsh-dt-inputwrap{position:relative}
.dsh-dt-tabhint{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;
  padding:1px 5px;border-radius:5px;border:1px solid ${C.border2};background:${C.layer2};color:${C.sub};
  pointer-events:none;letter-spacing:.4px}
.dsh-dt-btn{appearance:none;border:1px solid ${C.border2};background:${C.layer1};color:${C.text};font:inherit;
  font-size:12px;height:32px;padding:0 12px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;
  gap:5px;white-space:nowrap;transition:.14s}
.dsh-dt-btn:hover{background:${C.layer2};border-color:${C.border2}}
.dsh-dt-btn:disabled{opacity:.5;cursor:not-allowed}
.dsh-dt-btn[data-variant="primary"]{background:${C.brand};border-color:${C.brand};color:#fff;font-weight:600}
.dsh-dt-btn[data-variant="primary"]:hover{filter:brightness(1.06)}
.dsh-dt-btn[data-variant="ghost"]{border-color:transparent;background:transparent;color:${C.sub}}
.dsh-dt-btn[data-variant="ghost"]:hover{background:${C.layer2};color:${C.text}}
.dsh-dt-btn[data-size="sm"]{height:28px;font-size:11.5px;padding:0 9px}
.dsh-dt-foot{display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap}
.dsh-dt-hint{font-size:11px;color:${C.sub};display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dsh-dt-dot{width:6px;height:6px;border-radius:50%;flex:none;background:${C.idle}}
.dsh-dt-dot[data-state="online"]{background:${C.success};box-shadow:0 0 0 3px rgba(18,161,80,.16);animation:dsh-dt-pulse 2s ease-in-out infinite}
.dsh-dt-dot[data-state="connecting"]{background:${C.warn};animation:dsh-dt-pulse 1.2s ease-in-out infinite}
.dsh-dt-dot[data-state="error"]{background:${C.error}}
.dsh-dt-switch{position:relative;width:42px;height:24px;border-radius:999px;flex:none;cursor:pointer;
  border:1px solid ${C.border2};background:${C.layer2};transition:.18s;padding:0}
.dsh-dt-switch[data-on="1"]{background:${C.brand};border-color:${C.brand};box-shadow:0 2px 8px rgba(46,124,246,.32)}
.dsh-dt-switch span{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;
  box-shadow:0 1px 3px rgba(16,24,40,.28);transition:.18s}
.dsh-dt-switch[data-on="1"] span{left:20px}
.dsh-dt-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
  color:${C.sub};text-align:center;padding:40px 20px;line-height:1.65}
.dsh-dt-empty-title{font-size:14px;font-weight:620;color:${C.text}}
.dsh-dt-skel{height:44px;border-radius:14px;border:1px solid ${C.border1};
  background:linear-gradient(90deg,${C.layer2} 25%,${C.layer1} 37%,${C.layer2} 63%);
  background-size:400% 100%;animation:dsh-dt-shimmer 1.4s ease infinite}
.dsh-dt-modal-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(15,23,42,.44);backdrop-filter:blur(3px);animation:dsh-dt-fade .18s ease}
.dsh-dt-modal{width:min(560px,100%);max-height:86vh;overflow-y:auto;padding:20px 22px 18px;border-radius:18px;
  background:${C.overlay};border:1px solid ${C.border1};box-shadow:0 28px 72px rgba(15,23,42,.32);
  animation:dsh-dt-rise .2s cubic-bezier(.2,.8,.3,1)}
.dsh-dt-modal-title{font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}
.dsh-dt-modal-sub{font-size:12px;color:${C.sub};margin-top:5px;line-height:1.6}
.dsh-dt-modal-quote{margin-top:14px;padding:11px 13px;border-radius:11px;background:${C.layer2};
  border:1px solid ${C.border1};font-size:12.8px;line-height:1.62;white-space:pre-wrap;word-break:break-word;
  max-height:180px;overflow:auto}
.dsh-dt-modal-foot{display:flex;align-items:center;gap:9px;margin-top:16px;flex-wrap:wrap}
.dsh-dt-kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;padding:1px 5px;
  border-radius:5px;border:1px solid ${C.border2};background:${C.layer2};color:${C.sub}}
.dsh-dt-section{padding:18px 22px;border-radius:14px;border:1px solid ${C.border1};background:${C.layer1};
  margin:12px 20px;box-sizing:border-box}
.dsh-dt-kv{display:grid;grid-template-columns:150px 1fr;gap:8px 14px;font-size:12.5px;margin-top:12px}
.dsh-dt-kv dt{color:${C.sub}}
.dsh-dt-kv dd{margin:0;color:${C.text};word-break:break-word}
@keyframes dsh-dt-pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes dsh-dt-fade{from{opacity:0}to{opacity:1}}
@keyframes dsh-dt-rise{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
@keyframes dsh-dt-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
`

    function Styles() {
      // 必须走 dangerouslySetInnerHTML：React 会把 <style> 的文本子节点里的引号转义成
      // &quot;，导致 [data-on="1"]、[data-state="online"] 这类属性选择器整条失效。
      return h('style', { 'data-dingtalk-bridge': '1', dangerouslySetInnerHTML: { __html: STYLES } })
    }

    // ------------------------------------------------------------------ 共享 store

    const store = {
      state: null,
      error: '',
      listeners: new Set(),
      source: null,
      retryTimer: null,
      pollTimer: null,
      softTimer: null,
      started: false,
    }

    function emit() {
      for (const fn of store.listeners) {
        try {
          fn(store.state)
        } catch {
          // 单个订阅者异常不影响其它组件。
        }
      }
    }

    function applyState(next) {
      if (!next || typeof next !== 'object') return
      store.state = next
      store.error = ''
      emit()
    }

    async function fetchState() {
      try {
        const res = await fetch(`${API}/state`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data && data.state) applyState(data.state)
      } catch (error) {
        store.error = String(error && error.message ? error.message : error)
        emit()
      }
    }

    function scheduleReconnect() {
      if (store.retryTimer) return
      store.retryTimer = setTimeout(() => {
        store.retryTimer = null
        connectStream()
      }, 4000)
    }

    function connectStream() {
      if (typeof EventSource === 'undefined') {
        store.source = null
        return
      }
      try {
        const source = new EventSource(`${API}/events`)
        store.source = source
        source.onmessage = (event) => {
          try {
            applyState(JSON.parse(event.data))
          } catch {
            // 忽略坏帧。
          }
        }
        source.onerror = () => {
          try {
            source.close()
          } catch {
            // 忽略。
          }
          if (store.source === source) store.source = null
          scheduleReconnect()
        }
        source.onopen = () => {
          store.retryTimer = null
        }
      } catch {
        store.source = null
        scheduleReconnect()
      }
    }

    function startStore() {
      if (store.started) return
      store.started = true
      fetchState()
      connectStream()
      store.pollTimer = setInterval(() => {
        if (!store.source) fetchState()
      }, POLL_MS)
      // 即使 SSE 在线也做低频对账：DSH 里切换模型、重新登录后无需等下一次消息事件。
      store.softTimer = setInterval(() => {
        if (store.source) fetchState()
      }, SOFT_POLL_MS)
    }

    // 有些环境里 POST 会被宿主安全护栏挡下（GET 正常），所以失败时自动改用
    // 带查询参数的 GET /action 再试一次，两条通道在宿主里走同一套 handleAction。
    function actionQuery(payload) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(payload || {})) {
        if (value === undefined || value === null) continue
        params.set(key, String(value))
      }
      return `${API}/action?${params.toString()}`
    }

    function acceptResponse(data, res) {
      if (data && data.state) applyState(data.state)
      if (data && data.ok === false) {
        store.error = `${String(data.error || '操作未成功')}`
        emit()
        return false
      }
      if (res && !res.ok) {
        store.error = `操作失败（HTTP ${res.status}）`
        emit()
        return false
      }
      if (store.error) {
        store.error = ''
        emit()
      }
      return true
    }

    async function postAction(payload) {
      try {
        const res = await fetch(`${API}/action`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data && data.state) {
          acceptResponse(data, res)
          return data || {}
        }
        // POST 不通（403/401/空响应）：换 GET 通道重试。
        store.error = `操作被宿主拒绝（HTTP ${res.status}），已改用兼容通道重试`
        emit()
      } catch (error) {
        store.error = String(error && error.message ? error.message : error)
        emit()
      }

      try {
        const res = await fetch(actionQuery(payload), { credentials: 'same-origin', cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        acceptResponse(data, res)
        return data || {}
      } catch (error) {
        store.error = String(error && error.message ? error.message : error)
        emit()
        return { ok: false, error: store.error }
      }
    }

    function useBridge() {
      const [state, setState] = useState(store.state)
      const [error, setError] = useState(store.error)
      useEffect(() => {
        const listener = (next) => {
          setState(next)
          setError(store.error)
        }
        store.listeners.add(listener)
        startStore()
        if (store.state) setState(store.state)
        return () => {
          store.listeners.delete(listener)
        }
      }, [])
      return { state, error }
    }

    // ------------------------------------------------------------------ 工具函数

    const STATUS = {
      received: { label: '待生成建议', tone: 'idle' },
      suggesting: { label: '生成建议中', tone: 'idle' },
      suggested: { label: '建议已生成', tone: 'brand' },
      'needs-human': { label: '需要你确认', tone: 'warn' },
      waiting: { label: '已忽略', tone: 'idle' },
      'auto-replied': { label: '已自动回复', tone: 'success' },
      replied: { label: '已回复', tone: 'success' },
      failed: { label: '处理失败', tone: 'error' },
    }

    function statusMeta(message) {
      if (message.status === 'needs-human') return STATUS['needs-human']
      // 幂等键重复不是发送失败：这条回复大概率早就发出去了，提示可以换键重发即可。
      if (message.status === 'failed' && message.reply && message.reply.duplicate) {
        return { label: '已提交过', tone: 'warn' }
      }
      return STATUS[message.status] || STATUS.received
    }

    function cardTone(message) {
      if (message.status === 'failed' && message.reply && message.reply.duplicate) return 'warn'
      if (message.status === 'failed') return 'error'
      if (message.status === 'needs-human') return 'warn'
      if (message.reply && message.reply.ok) return 'success'
      return ''
    }

    function timeLabel(timestamp) {
      const value = Number(timestamp) || 0
      if (value <= 0) return ''
      const diff = Date.now() - value
      if (diff < 0) return '刚刚'
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      const sameYear = date.getFullYear() === new Date().getFullYear()
      const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      return sameYear ? stamp : `${date.getFullYear()}-${stamp}`
    }

    const AVATAR_GRADIENTS = [
      ['#2E7CF6', '#17B0F0'],
      ['#7C5CFC', '#B07CFF'],
      ['#F5623F', '#FF9A62'],
      ['#12A150', '#4ED17E'],
      ['#E5484D', '#FF8A8A'],
      ['#F5A524', '#FFC85C'],
      ['#0EA5A4', '#38D9C5'],
    ]

    function gradientOf(name) {
      const text = String(name || '?')
      let hash = 0
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      }
      return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]
    }

    function initialsOf(name) {
      const text = String(name || '').trim()
      if (text === '') return '?'
      return text.slice(-2)
    }

    function kindLabel(message) {
      return message.kind === 'group' ? '群 @' : '私信'
    }

    function sourceText(message) {
      if (message.kind === 'group') {
        return message.conversationTitle || '未命名群聊'
      }
      return '单聊'
    }

    function confidenceText(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return ''
      return `${Math.round(number * 100)}%`
    }

    /**
     * 当前模型能不能看图（来自 host 的探测结果）。
     * 只看图不分析时也要讲清楚原因，避免用户以为图片坏了。
     */
    function imageCapabilityText(state) {
      if (!state) return ''
      if (state.vision === true) return ' · 当前模型支持看图'
      if (state.vision === false) return ' · 当前模型不支持看图，图片只展示不分析'
      return ''
    }

    // ------------------------------------------------------------------ 基础组件

    function Badge(props) {
      return h(
        'span',
        { className: 'dsh-dt-badge', 'data-tone': props.tone || 'idle', title: props.title || undefined },
        props.children,
      )
    }

    /**
     * 匹配度胶囊：把模型自评的置信度明确画出来，自动回复与人工确认都能一眼看到「AI 有多确定」。
     * ≥80% 绿、≥60% 黄、其余红；没有建议时返回 null，不占位。
     */
    function ConfidencePill(props) {
      const raw = props.value
      const number = Number(raw)
      if (raw === null || raw === undefined || !Number.isFinite(number)) return null
      const percent = Math.round(number * 100)
      const tone = number >= 0.8 ? 'high' : number >= 0.6 ? 'mid' : 'low'
      return h(
        'span',
        {
          className: 'dsh-dt-conf',
          'data-tone': tone,
          title: props.title || `模型对该回复的自评匹配度：${percent}%`,
          'data-confidence': percent,
        },
        props.label || '匹配度',
        h('b', { style: { fontWeight: 650 } }, `${percent}%`),
      )
    }

    /**
     * 消息里的图片：缩略图直接从宿主 /media 路由取字节流。
     * 正在下载的显示骨架，失败的显示占位说明，点击在新窗口看原图。
     */
    function MessageImages(props) {
      const images = Array.isArray(props.images) ? props.images : []
      if (images.length === 0) return null
      const id = props.id || ''
      return h(
        'div',
        { className: 'dsh-dt-imgs' },
        images.map((image, index) => {
          const indexValue = image.index !== undefined ? image.index : index
          const url = `${API}/media?id=${encodeURIComponent(id)}&i=${indexValue}`
          if (image.state === 'ready') {
            return h(
              'a',
              {
                key: indexValue,
                className: 'dsh-dt-img',
                href: url,
                target: '_blank',
                rel: 'noreferrer',
                title: '在新窗口查看原图',
              },
              h('img', { src: url, alt: '消息图片', loading: 'lazy' }),
            )
          }
          if (image.state === 'failed') {
            return h(
              'div',
              { key: indexValue, className: 'dsh-dt-img', 'data-state': 'failed', title: image.error || '图片下载失败' },
              '图片不可用',
            )
          }
          return h('div', { key: indexValue, className: 'dsh-dt-img', 'data-state': 'loading' }, '加载中…')
        }),
      )
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-dt-btn',
          'data-variant': props.variant || 'default',
          'data-size': props.size || 'md',
          disabled: props.disabled || false,
          onClick: props.onClick,
          title: props.title || undefined,
        },
        props.children,
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-dt-switch',
          'data-on': props.checked ? '1' : '0',
          'aria-pressed': props.checked ? 'true' : 'false',
          'aria-label': props.label || '切换',
          onClick: () => props.onChange(!props.checked),
        },
        h('span'),
      )
    }

    function Avatar(props) {
      const [from, to] = gradientOf(props.name)
      return h(
        'div',
        {
          className: 'dsh-dt-avatar',
          style: { background: `linear-gradient(135deg, ${from}, ${to})` },
          'aria-hidden': 'true',
        },
        initialsOf(props.name),
      )
    }

    /**
     * 带「阴影建议」的输入框：建议文字以灰色显示在输入框内，按 Tab 补全，Enter 发送，Esc 收起。
     */
    function GhostInput(props) {
      const {
        value,
        suggestion,
        placeholder,
        disabled,
        autoFocus,
        onChange,
        onSubmit,
        ariaLabel,
      } = props
      const inputRef = useRef(null)

      const ghost = useMemo(() => {
        if (disabled) return ''
        const text = typeof suggestion === 'string' ? suggestion : ''
        if (text === '') return ''
        if (value === '') return text
        if (text.startsWith(value)) return text.slice(value.length)
        return ''
      }, [value, suggestion, disabled])

      useEffect(() => {
        if (autoFocus && inputRef.current) {
          try {
            inputRef.current.focus()
          } catch {
            // 忽略。
          }
        }
      }, [autoFocus])

      const handleKeyDown = (event) => {
        if (event.key === 'Tab' && ghost !== '') {
          event.preventDefault()
          onChange(value + ghost)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          try {
            if (inputRef.current) inputRef.current.blur()
          } catch {
            // 忽略。
          }
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          onSubmit()
        }
      }

      return h(
        'div',
        { className: 'dsh-dt-ghostwrap' },
        h(
          'div',
          { className: 'dsh-dt-inputwrap' },
          h('input', {
            ref: inputRef,
            className: 'dsh-dt-input',
            value,
            placeholder: ghost !== '' ? '' : placeholder,
            disabled,
            spellCheck: false,
            'aria-label': ariaLabel || '输入回复',
            onChange: (event) => onChange(event.target.value),
            onKeyDown: handleKeyDown,
          }),
          // 建议直接画在输入框内（灰色阴影字），叠在 input 之上以便肉眼可见。
          ghost !== ''
            ? h(
                'div',
                { className: 'dsh-dt-ghost', 'aria-hidden': 'true', title: `建议回复：${suggestion}` },
                h('span', { style: { visibility: 'hidden' } }, value),
                h('span', null, ghost),
              )
            : null,
          ghost !== '' ? h('span', { className: 'dsh-dt-tabhint' }, 'Tab') : null,
        ),
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'dsh-dt-empty' },
        h(
          'svg',
          { width: 56, height: 56, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M24 6C13.5 6 5 13.5 5 22.8c0 5.2 2.7 9.8 7 12.9v6.9c0 .8.9 1.3 1.6.8l7.4-4.9c1 .2 2 .3 3 .3 10.5 0 19-7.5 19-16.8S34.5 6 24 6Z',
            fill: 'rgba(46,124,246,.12)',
            stroke: 'rgba(46,124,246,.42)',
            strokeWidth: '1.6',
          }),
          h('path', {
            d: 'M17 19.5h14M17 24.5h9',
            stroke: 'rgba(46,124,246,.55)',
            strokeWidth: '1.8',
            strokeLinecap: 'round',
          }),
        ),
        h('div', { className: 'dsh-dt-empty-title' }, props.title || '暂无消息'),
        h('div', { style: { maxWidth: '360px', fontSize: 12.5 } }, props.description || ''),
        props.children || null,
      )
    }

    // ------------------------------------------------------------------ 消息卡片

    function MessageCard(props) {
      const { message, autoReply, groupReplyAt, busy, onSend, onRegenerate, onDismiss } = props
      const [value, setValue] = useState('')
      const suggestion = message.suggestion && message.suggestion.text ? message.suggestion.text : ''
      const meta = statusMeta(message)
      const tone = cardTone(message)
      const replied = message.reply && message.reply.ok
      const suggesting = message.status === 'suggesting'
      const showComposer = !(replied && message.reply.auto)
      const canSend = (value.trim() !== '' || suggestion !== '') && !busy

      const submit = async () => {
        if (!canSend) return
        const text = value.trim() !== '' ? value.trim() : suggestion
        const result = await onSend(message.id, text)
        if (result && result.ok !== false) setValue('')
      }

      const confidence =
        message.suggestion && message.suggestion.confidence !== null && message.suggestion.confidence !== undefined
          ? message.suggestion.confidence
          : null

      return h(
        'div',
        { className: 'dsh-dt-card dsh-dt-fade', 'data-tone': tone },
        h(
          'div',
          { className: 'dsh-dt-row' },
          h(Avatar, { name: message.sender }),
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'dsh-dt-sender' }, message.sender),
            h(
              'div',
              { className: 'dsh-dt-meta' },
              h(Badge, { tone: message.kind === 'group' ? 'warn' : 'brand' }, kindLabel(message)),
              h('span', { style: { opacity: 0.65 } }, '·'),
              h('span', null, sourceText(message)),
              h('span', { style: { opacity: 0.65 } }, '·'),
              h('span', null, timeLabel(message.at)),
            ),
          ),
          !replied && confidence !== null ? h(ConfidencePill, { value: confidence, label: '匹配度 ' }) : null,
          h(Badge, { tone: meta.tone }, meta.label),
        ),

        message.images && message.images.length > 0
          ? h(MessageImages, { id: message.id, images: message.images })
          : null,

        h('div', { className: 'dsh-dt-text' }, message.text),

        message.quoted
          ? h('div', { className: 'dsh-dt-quote' }, `引用 ${message.quoted}`)
          : null,

        replied
          ? h(
              'div',
              { className: 'dsh-dt-replybox', 'data-fail': '0' },
              message.reply.atSender
                ? h('span', { className: 'dsh-dt-at', title: '群消息回复会自动 @ 回发送人' }, `@${message.sender} `)
                : null,
              `${message.reply.auto ? '已自动回复' : '已回复'}：`,
              Array.isArray(message.reply.parts) && message.reply.parts.length > 1
                ? h(
                    'div',
                    { className: 'dsh-dt-parts' },
                    message.reply.parts.map((part, index) =>
                      h('div', { className: 'dsh-dt-part', key: `${message.id}-part-${index}` }, h('span', { className: 'dsh-dt-partno' }, index + 1), part.text),
                    ),
                  )
                : message.reply.text,
            )
          : null,

        message.reply && message.reply.ok === false && message.reply.duplicate
          ? h(
              'div',
              { className: 'dsh-dt-replybox', 'data-duplicate': '1' },
              `幂等键重复：${message.reply.error || '钉钉认为这条回复已经提交过'}（第 ${message.reply.attempt || 1} 次尝试；再点「发送」会自动换新的幂等键重发）`,
            )
          : message.reply && message.reply.ok === false
            ? h('div', { className: 'dsh-dt-replybox', 'data-fail': '1' }, `发送失败：${message.reply.error || message.error}`)
            : null,

        replied && confidence !== null
          ? h(
              'div',
              { className: 'dsh-dt-hint', style: { marginTop: 7, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
              h(ConfidencePill, { value: confidence, label: '本次回复匹配度 ' }),
              h(
                'span',
                { style: { opacity: 0.8 } },
                message.reply.auto
                  ? `AI 自评匹配度达到阈值，已自动发送${message.reply.matchBy === 'images' ? '（含图片分析）' : ''}`
                  : '人工确认后发送',
              ),
            )
          : null,

        message.autoCancelled && !replied
          ? h(
              'div',
              { className: 'dsh-dt-hint', style: { color: C.warn, marginTop: 8 } },
              '⏸ 自动回复已关闭，本条不会自动发送（可手动发送下面这条建议）',
            )
          : null,

        message.error && !(message.reply && message.reply.ok === false)
          ? h('div', { className: 'dsh-dt-hint', style: { color: C.error, marginTop: 8 } }, `⚠ ${message.error}`)
          : null,

        message.kind === 'group' && groupReplyAt !== false && !(message.reply && message.reply.atSender)
          ? h(
              'div',
              { className: 'dsh-dt-hint', 'data-at-hint': '1', style: { marginTop: 8, color: C.brand } },
              `回复时会先 @${message.sender}（谁 @ 我，我就 @ 谁）`,
            )
          : null,

        suggesting
          ? h(
              'div',
              { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'dsh-dt-skel', style: { height: 30 } }),
              h('div', { className: 'dsh-dt-hint' }, 'AI 正在根据消息来源的上下文生成建议回复…'),
            )
          : null,

        showComposer && !suggesting
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dsh-dt-composer' },
                h(GhostInput, {
                  value,
                  suggestion,
                  disabled: busy,
                  placeholder: replied ? '已回复，可继续补充…' : message.kind === 'group' && groupReplyAt !== false ? `回复 @${message.sender}，Tab 补全建议…` : '输入回复，Tab 补全建议…',
                  onChange: setValue,
                  onSubmit: submit,
                  ariaLabel: `回复 ${message.sender}`,
                  autoFocus: message.status === 'needs-human',
                }),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: !canSend,
                    onClick: submit,
                    title: '发送回复（Enter）',
                  },
                  busy ? '发送中…' : '发送',
                ),
              ),
              h(
                'div',
                { className: 'dsh-dt-foot' },
                suggestion !== ''
                  ? h(
                      'div',
                      { className: 'dsh-dt-hint' },
                      h('span', { className: 'dsh-dt-dot', 'data-state': 'online' }),
                      `建议置信度 ${confidenceText(message.suggestion.confidence)}`,
                      message.suggestion.needsHuman ? ' · 需人工确认' : '',
                      Number(message.suggestion.contextCount) > 0
                        ? ` · 参考本来源 ${Number(message.suggestion.contextCount)} 条上下文`
                        : '',
                      Number(message.suggestion.imageCount) > 0
                        ? ` · 已结合 ${Number(message.suggestion.imageCount)} 张图片`
                        : message.images && message.images.length > 0
                          ? ' · 图片未纳入分析'
                          : '',
                      Array.isArray(message.suggestion.replies) && message.suggestion.replies.length > 1
                        ? h(
                            'span',
                            { className: 'dsh-dt-multi', title: '点「发送」会按顺序连发这几条消息' },
                            ` · 将分 ${message.suggestion.replies.length} 条依次发送`,
                          )
                        : null,
                      message.suggestion.reason
                        ? h('span', { style: { opacity: 0.8 } }, ` · ${String(message.suggestion.reason).slice(0, 60)}`)
                        : null,
                    )
                  : h(
                      'div',
                      { className: 'dsh-dt-hint' },
                      autoReply ? '自动回复未能判断，请手动确认' : '暂无建议，可点击「生成建议」',
                    ),
                h('div', { className: 'dsh-dt-spacer' }),
                h(
                  Button,
                  {
                    size: 'sm',
                    variant: 'ghost',
                    disabled: busy,
                    onClick: () => onRegenerate(message.id),
                  },
                  suggestion !== '' ? '换一个建议' : '生成建议',
                ),
                message.needsHuman
                  ? h(
                      Button,
                      { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => onDismiss(message.id) },
                      '忽略',
                    )
                  : null,
              ),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ 说明内容

    const HELP_ITEMS = [
      [
        '授权',
        '首次使用点右上角「钉钉授权」：默认 loopback 模式会弹出钉钉授权页，扫码或登录即完成，不需要抄授权码；设备流才显示二维码与授权码。',
      ],
      [
        '重新授权 / 退出',
        '已登录时按钮变成「重新授权」：默认会先退出已登录的组织再登录新的组织（配置 loginReset），所以始终只监听你本次授权的组织，不会越授权越多；想彻底断开就点旁边的「退出」。',
      ],
      ['接收', '插件自动登录 dws 后订阅「私信」与「群 @我」两类事件，消息到达即刻推送到本页，无需刷新。'],
      [
        'dws 环境',
        '插件依赖 dws CLI 收发钉钉消息。如果这台机器没装 dws，顶部会出现一条提示，点「安装 dws」会自动执行 npm install -g dingtalk-workspace-cli（需要本机有 Node.js），装完自动重新检测并开始接收；已装的话点「检查更新」可以看 npm 上有没有新版本，再点「更新到 vX」升级。npm 源可用配置项 dwsRegistry 换成国内镜像。',
      ],
      ['消息源', '每条消息记录发送人、来源类型（私信 / 群 @）、群名称与时间；顶部「来源」筛选条按发送人与群聚合统计。'],
      [
        '来源筛选',
        '来源条只占一行：按消息数排序，默认显示前 5 个，其余收进「还有 N 个 ▾」。点开可在面板里搜索来源、面板内滚动、一键清除筛选；当前选中的来源会被置顶，永远看得见。',
      ],
      [
        '自动回复开关',
        '位于收件箱顶部。关闭时每条消息下方都有独立输入框；开启后 AI 先判断能否直接回复，没把握时在主界面弹框等你确认。',
      ],
      [
        '可信度阈值',
        '开关下方的滑杆：建议置信度达到阈值且 AI 判断明确才会自动发出，低于阈值一律转人工确认；拖动即时生效并自动保存（40%–100%）。',
      ],
      ['匹配度', '每条消息都会标出模型对该回复的自评匹配度；自动回复的消息还会注明「达到阈值自动发送」。'],
      [
        '群 @ 回复',
        '群里的 @ 消息回复时会先在正文 @ 回发送人（谁 @ 我，我就 @ 谁），回复气泡上会标出「@发送人」；私信不 @。可用配置 groupReplyAt 关掉。',
      ],
      [
        '连续多条',
        '对方要求「连发几条」时，AI 会把回复拆成 2~5 条短消息依次发出（每条之间隔 0.6 秒）；建议提示行会显示「将分 N 条依次发送」，发出的气泡按 1/2/3 编号列出。自己输入时用换行分隔也能拆成多条。上限与间隔可用 multiSendMax / multiSendDelayMs 调整，multiSend 关闭后永远只发一条。',
      ],
      [
        '图片消息',
        '收到的图片会自动下载并展示缩略图；当前模型支持视觉时会连同图片一起交给模型理解，模型不看图时按纯文本回复。',
      ],
      [
        '上下文',
        '每个消息来源（私信按发送人、群 @ 按群）各有一条独立的滑动窗口，只保留最近 5 条：新消息进来就把最早一条挤出去。条数可在上方「自动回复」卡片里的「上下文窗口」下拉框直接改（2/3/5/8/10/15/20 条），也可以改配置项 windowMessages。生成建议时 AI 只看本来源窗口里的内容，所以不同群、不同人的对话不会串在一起；窗口还没攒满时会先用钉钉上该会话的最新消息补齐。',
      ],
      ['阴影建议', '输入框里的浅灰文字是 AI 生成的建议回复：按 Tab 一键补全，也可以直接改写，回车或点「发送」发到钉钉。'],
      ['模型', '建议回复使用你在 DSH 里当前选中的大模型，收件箱卡片与设置页都会实时显示当前模型。'],
      ['快捷键', 'Tab 补全建议，Enter 发送，Esc 收起输入框；弹框里同样适用。'],
      ['发送通道', '回复通过 dws 以你本人的钉钉身份发出：群消息回到原群，私信回到原会话。'],
    ]

    const HELP_STEPS = [
      ['1', '先完成钉钉授权', '点右上角「钉钉授权」，loopback 模式会弹出钉钉授权页，扫码或登录即完成，不用抄授权码；已登录时按钮变「重新授权」，会先退出旧组织再登录新的。'],
      ['2', '选择工作方式', '打开「自动回复」：AI 判断明确就直接替你回复，没把握会在主界面弹框等你确认；关闭它，则每条消息下方都有独立输入框手动回复。'],
      ['3', '按需调整阈值', '滑杆越高越保守：只有置信度达到阈值的建议才会自动发出，其余一律转人工确认；拖动即时生效并自动保存。'],
    ]

    function HelpContent() {
      return h(
        'div',
        { className: 'dsh-dt-help' },
        h(
          'div',
          { className: 'dsh-dt-helpsteps' },
          HELP_STEPS.map(([index, title, body]) =>
            h(
              'div',
              { key: index, className: 'dsh-dt-helpstep' },
              h('div', { className: 'dsh-dt-stephead' }, h('i', null, index), h('span', null, title)),
              h('div', { className: 'dsh-dt-stepbody' }, body),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-dt-helpgrid' },
          HELP_ITEMS.map(([title, body]) =>
            h(
              'div',
              { key: title, className: 'dsh-dt-helpitem' },
              h('div', { className: 'dsh-dt-helptag' }, title),
              h('div', { style: { fontSize: 12.5, lineHeight: 1.65, color: C.text } }, body),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-dt-links' },
          h(
            'a',
            { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', title: '在 GitHub 上给这个插件点个 Star' },
            '★ Star',
          ),
          h(
            'a',
            { href: `${ISSUES_URL}/new`, target: '_blank', rel: 'noopener noreferrer', title: '反馈问题或提功能建议' },
            '🐞 提交 Issue',
          ),
          h('a', { href: NPM_URL, target: '_blank', rel: 'noopener noreferrer', title: '在 npm 上查看版本与安装信息' }, 'npm'),
          h('span', null, '欢迎点赞或反馈问题'),
        ),
      )
    }

    // ------------------------------------------------------------------ 收件箱主面板

    function listenerSummary(state) {
      const listeners = Array.isArray(state && state.listeners) ? state.listeners : []
      const online = listeners.filter((item) => item.status === 'online')
      const errors = listeners.filter((item) => item.status === 'error')
      const expired = Array.isArray(state && state.expiredProfiles) ? state.expiredProfiles.length : 0
      const expiredNote = expired > 0 ? ` · ${expired} 个组织登录已过期，建议重新授权` : ''
      if (!state || !state.enabled) return { dot: 'error', text: '插件已禁用', detail: '在设置 → 插件中启用后可用' }
      if (!state.tool || !state.tool.ok) {
        return { dot: 'error', text: 'dws 未就绪', detail: state.tool && state.tool.error ? state.tool.error : '请检查 dws 是否已安装并登录' }
      }
      if (online.length > 0) {
        return {
          dot: 'online',
          text: `实时监听中 · ${online.length} 个组织`,
          detail: `以 ${state.selfName || '当前账号'} 身份接收私信与群 @${expiredNote}`,
        }
      }
      if (errors.length > 0) {
        return { dot: 'error', text: '监听异常', detail: `${errors[0].error || '正在重连，请稍候'}${expiredNote}` }
      }
      return { dot: 'connecting', text: '正在连接钉钉…', detail: `首次连接需要几秒钟${expiredNote}` }
    }

    function needsAction(message) {
      if (message.dismissed) return false
      if (message.reply && message.reply.ok) return false
      return true
    }

    // 上下文窗口可选项：2–20 条，默认 5 条（与 config.windowMessages 的取值范围一致）。
    const WINDOW_OPTIONS = [2, 3, 5, 8, 10, 15, 20]

    // 来源筛选条：折叠时只显示「全部来源 + 计数最高的 5 个 + 还有 N 个」，
    // 不会因为来源变多而把后面的来源悄悄挤出可视区；展开后变成可换行、可搜索、可滚动的面板。
    const SOURCE_INLINE_MAX = 5

    function sourceLabel(item) {
      if (!item) return '未知来源'
      return item.kind === 'group' ? item.conversationTitle || '未命名群聊' : item.sender || item.label || '未知来源'
    }

    function SourceChip({ item, active, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-dt-src',
          'data-active': active ? '1' : '0',
          onClick,
          title: `${item.kind === 'group' ? '群聊' : '私信'}：${sourceLabel(item)} · ${item.count} 条`,
        },
        h('span', {
          className: 'dsh-dt-dot',
          'data-state': item.kind === 'group' ? 'online' : 'connecting',
          style: { background: item.kind === 'group' ? C.warn : C.brand, animation: 'none' },
        }),
        h('span', { className: 'dsh-dt-srcname' }, sourceLabel(item)),
        h('span', { style: { opacity: 0.6, fontSize: 10.5 } }, item.count),
      )
    }

    function SourceBar({ sources, total, value, onChange }) {
      // 默认折叠；调试/截图时可在页面里设 window.__DSH_DINGTALK_SOURCES_OPEN__ = true 让它一进来就展开。
      const [open, setOpen] = useState(
        () => Boolean(typeof window !== 'undefined' && window.__DSH_DINGTALK_SOURCES_OPEN__),
      )
      const [query, setQuery] = useState('')

      const ordered = useMemo(() => {
        const list = [...(sources || [])]
        list.sort((a, b) => (b.count || 0) - (a.count || 0) || (b.lastAt || 0) - (a.lastAt || 0))
        return list
      }, [sources])

      const selected = ordered.find((item) => item.key === value) || null
      const inline = useMemo(() => {
        const head = ordered.slice(0, SOURCE_INLINE_MAX)
        if (selected && !head.some((item) => item.key === selected.key)) head.unshift(selected)
        return head
      }, [ordered, selected])

      const rest = ordered.length - inline.length
      const keyword = query.trim().toLowerCase()
      const panelList =
        keyword === ''
          ? ordered
          : ordered.filter((item) => `${sourceLabel(item)} ${item.sender || ''} ${item.conversationTitle || ''}`.toLowerCase().includes(keyword))

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dsh-dt-sources' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-dt-src',
              'data-active': value === '' ? '1' : '0',
              onClick: () => onChange(''),
            },
            '全部来源',
            h('span', { style: { opacity: 0.6 } }, total),
          ),
          inline.map((item) =>
            h(SourceChip, {
              key: item.key,
              item,
              active: value === item.key,
              onClick: () => onChange(value === item.key ? '' : item.key),
            }),
          ),
          rest > 0 || open
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-dt-src',
                  'data-more': '1',
                  onClick: () => setOpen((prev) => !prev),
                  title: open ? '收起来源列表' : `还有 ${Math.max(rest, 0)} 个来源，点开查看全部`,
                },
                open ? '收起' : `还有 ${rest} 个`,
                h('span', { style: { opacity: 0.7, fontSize: 10.5 } }, open ? '▴' : '▾'),
              )
            : null,
        ),
        open
          ? h(
              'div',
              { className: 'dsh-dt-srcpanel' },
              h(
                'div',
                { className: 'dsh-dt-srcpanel-head' },
                h('span', null, `全部来源（${ordered.length}）`),
                ordered.length > 8
                  ? h('input', {
                      className: 'dsh-dt-srcsearch',
                      value: query,
                      placeholder: '按群名或发送人筛选来源…',
                      onChange: (event) => setQuery(event.target.value),
                    })
                  : h('span', { style: { flex: 1 } }),
                value !== ''
                  ? h(
                      Button,
                      { size: 'sm', variant: 'ghost', onClick: () => onChange('') },
                      '清除筛选',
                    )
                  : null,
              ),
              panelList.length === 0
                ? h('div', { className: 'dsh-dt-hint' }, '没有匹配的来源')
                : h(
                    'div',
                    { className: 'dsh-dt-srcpanel-body' },
                    panelList.map((item) =>
                      h(SourceChip, {
                        key: item.key,
                        item,
                        active: value === item.key,
                        onClick: () => onChange(value === item.key ? '' : item.key),
                      }),
                    ),
                  ),
            )
          : null,
      )
    }

    /**
     * dws 检测 / 安装 / 更新卡片。
     * 只有用户点按钮才会真的执行 npm install（插件启动时只做「检测」和「查最新版本」）。
     */
    function DwsInstallCard(props) {
      const install = props.install || {}
      const tool = props.tool || {}
      const status = String(install.status || 'unknown')
      const current = String(install.currentVersion || tool.version || '')
      const latest = String(install.latestVersion || '')
      const updateAvailable = Boolean(status === 'ready' && latest && current && latest !== current)
      const ready = Boolean(tool.ok)
      if (ready && !updateAvailable) return null

      const source = String(install.source || '配置的 npm 源')
      const busy = props.busy || ''
      const installing = status === 'installing' || busy === 'install-dws' || busy === 'update-dws'
      const failed = status === 'error'
      const tone = failed ? C.error : installing ? C.brand : C.warn

      const headline = installing
        ? `正在安装 dws${install.targetVersion ? ` v${install.targetVersion}` : ''}…`
        : failed
          ? 'dws 安装 / 更新失败'
          : ready
            ? `发现新版本 dws v${latest}（当前 v${current}）`
            : '未检测到 dws 命令'

      const body = installing
        ? '安装过程通常需要 10~60 秒，完成后会自动重新检测并开始接收消息。'
        : failed
          ? String(install.log || tool.error || '安装失败，请查看下面的日志。').slice(0, 600)
          : ready
            ? `更新后会重启监听，登录状态不受影响。安装来源：${source}`
            : `这个插件通过 dws CLI 收发钉钉消息。点「安装 dws」会自动执行 npm install -g dingtalk-workspace-cli（来源：${source}），需要本机已安装 Node.js。`

      return h(
        'div',
        { className: 'dsh-dt-install', 'data-tone': failed ? 'error' : installing ? 'busy' : 'warn' },
        h('div', { className: 'dsh-dt-install-icon', style: { color: tone } }, installing ? '⏳' : failed ? '⚠' : '📦'),
        h(
          'div',
          { style: { minWidth: 0, flex: 1 } },
          h('div', { className: 'dsh-dt-install-title' }, headline),
          h('div', { className: 'dsh-dt-install-body' }, body),
          failed && install.log && install.log.length > 600
            ? h('details', { className: 'dsh-dt-install-log' }, h('summary', null, '查看完整日志'), h('pre', null, install.log))
            : null,
          install.latestError
            ? h('div', { className: 'dsh-dt-install-body', style: { opacity: 0.75 } }, `查询最新版本失败：${install.latestError}`)
            : null,
        ),
        h(
          'div',
          { className: 'dsh-dt-install-actions' },
          ready && updateAvailable
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'primary',
                  disabled: installing,
                  onClick: props.onUpdate,
                  title: `更新到 v${latest}`,
                },
                installing ? '更新中…' : `更新到 v${latest}`,
              )
            : null,
          !ready
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'primary',
                  disabled: installing,
                  onClick: props.onInstall,
                  title: '执行 npm install -g dingtalk-workspace-cli',
                },
                installing ? '安装中…' : '安装 dws',
              )
            : null,
          h(
            Button,
            { size: 'sm', variant: 'ghost', disabled: installing || busy === 'check-dws-update', onClick: props.onCheck },
            busy === 'check-dws-update' ? '检查中…' : '检查更新',
          ),
        ),
      )
    }

    function InboxPanel() {
      const { state, error } = useBridge()
      const [tab, setTab] = useState('all')
      const [query, setQuery] = useState('')
      const [sourceFilter, setSourceFilter] = useState('')
      const [helpOpen, setHelpOpen] = useState(false)
      const [busyId, setBusyId] = useState('')
      const [thresholdDraft, setThresholdDraft] = useState(null)
      const [pendingThreshold, setPendingThreshold] = useState(null)
      const [thresholdError, setThresholdError] = useState('')
      const [installBusy, setInstallBusy] = useState('')

      const messages = useMemo(() => (state && Array.isArray(state.messages) ? state.messages : []), [state])
      const autoReply = Boolean(state && state.autoReply)
      const summary = listenerSummary(state)

      const minConfidence = state && typeof state.minConfidence === 'number' ? state.minConfidence : 0.72
      const savedPct = Math.round(minConfidence * 100)
      // 滑杆用「百分数」当单位，state.minConfidence 是 0~1，两套单位不能相乘（否则 57 → 5700%）。
      // pendingThreshold：刚提交、还没被宿主确认的值，先显示它，避免「松手就跳回旧值」。
      useEffect(() => {
        if (pendingThreshold !== null && savedPct === pendingThreshold) setPendingThreshold(null)
      }, [pendingThreshold, savedPct])
      const thresholdPct = Math.round(
        thresholdDraft !== null ? thresholdDraft : pendingThreshold !== null ? pendingThreshold : savedPct,
      )
      const commitThreshold = useCallback((percent) => {
        const next = Math.max(40, Math.min(100, Math.round(Number(percent) || 0)))
        setThresholdDraft(null)
        setPendingThreshold(next)
        setThresholdError('')
        return postAction({ type: 'set-min-confidence', value: next / 100 }).then((data) => {
          const actual =
            data && data.state && typeof data.state.minConfidence === 'number'
              ? Math.round(data.state.minConfidence * 100)
              : null
          if (actual === null || actual !== next) {
            setThresholdError(
              `阈值 ${next}% 没能保存（宿主返回 ${actual === null ? '空响应' : `${actual}%`}），请看页面顶部的错误提示。`,
            )
          }
          return data
        })
      }, [])
      // 拖动过程只改本地值（跟手、不打断手势），松手/失焦/键盘调整时才落库。
      const [dragging, setDragging] = useState(false)
      const previewThreshold = useCallback((percent) => {
        const next = Math.max(40, Math.min(100, Math.round(Number(percent) || 0)))
        setThresholdDraft(next)
      }, [])
      const finishThreshold = useCallback(
        (percent) => {
          setDragging(false)
          const next = Math.max(40, Math.min(100, Math.round(Number(percent) || 0)))
          setThresholdDraft(null)
          commitThreshold(next)
        },
        [commitThreshold],
      )

      // 上下文窗口长度：每个来源各留最近 N 条，选中即保存（宿主会立刻裁剪已有窗口）。
      const windowMessages =
        state && typeof state.windowMessages === 'number' ? Math.round(state.windowMessages) : 5
      const commitWindow = useCallback((size) => {
        const next = Math.max(2, Math.min(20, Math.round(Number(size) || 5)))
        return postAction({ type: 'set-window-messages', value: next })
      }, [])

      const model = (state && state.model) || null
      const modelLabel =
        model && model.model
          ? `${model.model}`
          : state && state.autoSuggest
            ? '跟随 DSH 当前模型'
            : '自动建议已关闭'
      const modelDetail =
        model && model.model
          ? `${model.provider || '未知 provider'} / ${model.model}｜来源：${{
              dsh: '跟随 DSH 当前模型',
              config: '插件配置指定',
              hybrid: '自定义 provider + DSH 模型',
              none: '未检测到模型',
            }[model.source] || '跟随 DSH 当前模型'}`
          : '建议回复会使用 DSH 平台当前正在使用的大模型'

      const login = (state && state.login) || null
      const notLoggedIn = Boolean(state && Array.isArray(state.profiles) && state.profiles.length === 0)
      const loginPending = Boolean(login && login.status === 'pending')
      const orgCount = state && Array.isArray(state.profiles) ? state.profiles.length : 0
      const expiredCount = state && Array.isArray(state.expiredProfiles) ? state.expiredProfiles.length : 0

      // 重新授权默认会先退出旧组织（loginReset），所以先让用户确认一次，避免误点断掉监听。
      const startLogin = useCallback(() => {
        const reset = !state || state.loginReset !== false
        if (orgCount > 0 && reset) {
          const confirmed = window.confirm(
            `重新授权会先退出当前已登录的 ${orgCount} 个钉钉组织，期间实时监听会短暂中断，然后请你在授权页登录新的组织。\n\n继续吗？`,
          )
          if (!confirmed) return Promise.resolve({ ok: false, error: 'cancelled' })
        }
        return postAction({ type: 'login-start' })
      }, [state, orgCount])

      const logoutAll = useCallback(() => {
        const confirmed = window.confirm(
          `确定退出钉钉登录吗？\n\n会停掉实时监听并执行 dws auth logout（退出全部组织），退出后需要重新授权才能继续接收消息。`,
        )
        if (!confirmed) return Promise.resolve({ ok: false, error: 'cancelled' })
        return postAction({ type: 'logout' })
      }, [])

      const counts = useMemo(() => {
        const total = messages.length
        const dm = messages.filter((item) => item.kind === 'dm').length
        const group = messages.filter((item) => item.kind === 'group').length
        const pending = messages.filter(needsAction).length
        return { total, dm, group, pending }
      }, [messages])

      const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        return messages.filter((item) => {
          if (tab === 'dm' && item.kind !== 'dm') return false
          if (tab === 'group' && item.kind !== 'group') return false
          if (tab === 'pending' && !needsAction(item)) return false
          if (sourceFilter !== '' && item.sourceKey !== sourceFilter) return false
          if (keyword !== '') {
            const haystack = `${item.sender} ${item.text} ${item.conversationTitle || ''}`.toLowerCase()
            if (!haystack.includes(keyword)) return false
          }
          return true
        })
      }, [messages, tab, sourceFilter, query])

      const sources = useMemo(() => (state && Array.isArray(state.sources) ? state.sources.slice(0, 12) : []), [state])

      const handleSend = useCallback(async (id, text) => {
        setBusyId(id)
        try {
          return await postAction({ type: 'send-reply', id, text })
        } finally {
          setBusyId('')
        }
      }, [])

      const handleRegenerate = useCallback(async (id) => {
        setBusyId(id)
        try {
          return await postAction({ type: 'regenerate', id })
        } finally {
          setBusyId('')
        }
      }, [])

      const handleDismiss = useCallback((id) => postAction({ type: 'dismiss', id }), [])

      const toggleAuto = useCallback((next) => postAction({ type: 'set-auto-reply', enabled: next }), [])

      const tabs = [
        { id: 'all', label: '全部', count: counts.total },
        { id: 'dm', label: '私信', count: counts.dm },
        { id: 'group', label: '群 @', count: counts.group },
        { id: 'pending', label: '待回复', count: counts.pending },
      ]

      return h(
        'div',
        { className: 'dsh-dt-root' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-dt-header' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h(
              'div',
              { className: 'dsh-dt-title' },
              h(BrandIcon, { size: 20 }),
              h('span', { className: 'dsh-dt-dot', 'data-state': summary.dot }),
              '钉钉消息自动化',
            ),
            h(
              'div',
              { className: 'dsh-dt-sub' },
              h('span', null, summary.text),
              summary.detail ? h('span', { style: { opacity: 0.7 } }, `· ${summary.detail}`) : null,
            ),
          ),
          h('div', { className: 'dsh-dt-spacer' }),
          h(
            Button,
            {
              size: 'sm',
              variant: notLoggedIn || loginPending ? 'primary' : 'ghost',
              onClick: startLogin,
              title:
                login && login.status === 'pending'
                  ? '正在等待钉钉授权，点击重新展示授权方式'
                  : notLoggedIn
                    ? '尚未登录钉钉，点击开始扫码授权'
                    : '重新授权：会先退出当前组织，再登录新的组织',
            },
            login && login.status === 'pending' ? '授权中…' : notLoggedIn ? '钉钉授权' : '重新授权',
          ),
          !notLoggedIn && !loginPending
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'ghost',
                  onClick: logoutAll,
                  title: '退出钉钉登录（dws auth logout），退出后需重新授权',
                },
                '退出',
              )
            : null,
          state && state.dryRun
            ? h(
                Badge,
                { tone: 'warn', title: '演练模式：只预览发送内容，不会真正发到钉钉' },
                '演练模式',
              )
            : null,
          state && state.build && String(state.build).indexOf(CLIENT_BUILD) !== 0
            ? h(
                Badge,
                {
                  tone: 'warn',
                  title: `界面代码是 ${CLIENT_BUILD}，正在跑的宿主代码是 ${state.build}。重启 DSH 后两端才会一致，否则新功能（如群 @ 回复）不会生效。`,
                },
                '宿主待重启',
              )
            : null,
          h(
            Button,
            { size: 'sm', variant: 'ghost', onClick: () => postAction({ type: 'refresh' }), title: '刷新账号与监听状态' },
            '刷新',
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              onClick: () => postAction({ type: 'restart-listeners' }),
              title: '重启事件监听',
            },
            '重启监听',
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: helpOpen ? 'primary' : 'ghost',
              onClick: () => setHelpOpen((prev) => !prev),
              title: helpOpen ? '回到收件箱列表' : '只看使用说明与自动回复设置',
            },
            helpOpen ? '返回收件箱' : '使用说明',
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              onClick: () => openExternal(REPO_URL),
              title: '在 GitHub 上查看源码、点个 Star 支持作者',
            },
            '★ Star',
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              onClick: () => openExternal(`${ISSUES_URL}/new`),
              title: '提交 Issue：反馈问题或提功能建议',
            },
            '提交 Issue',
          ),
          h('span', { className: 'dsh-dt-footnote' }, '欢迎点赞或反馈问题'),
        ),

        h(DwsInstallCard, {
          install: state && state.install,
          tool: state && state.tool,
          busy: installBusy,
          onInstall: () => {
            setInstallBusy('install-dws')
            postAction({ type: 'install-dws' }).finally(() => setInstallBusy(''))
          },
          onUpdate: () => {
            const target = String((state && state.install && state.install.latestVersion) || '')
            const source = String((state && state.install && state.install.source) || '配置的 npm 源')
            if (!window.confirm(`将更新 dingtalk-workspace-cli 到 v${target}（来源：${source}），是否继续？`)) return
            setInstallBusy('update-dws')
            postAction({ type: 'update-dws' }).finally(() => setInstallBusy(''))
          },
          onCheck: () => {
            setInstallBusy('check-dws-update')
            postAction({ type: 'check-dws-update' }).finally(() => setInstallBusy(''))
          },
        }),

        helpOpen ? null : h(
          'div',
          { className: 'dsh-dt-toolbar' },
          h(
            'div',
            { className: 'dsh-dt-tabs' },
            tabs.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'dsh-dt-tab',
                  'data-active': tab === item.id ? '1' : '0',
                  onClick: () => setTab(item.id),
                },
                item.label,
                h('span', { className: 'dsh-dt-count' }, item.count),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-dt-search' },
            h(
              'svg',
              { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              h('circle', { cx: 7, cy: 7, r: 5, stroke: C.sub, strokeWidth: 1.6 }),
              h('path', { d: 'M11 11l3.2 3.2', stroke: C.sub, strokeWidth: 1.6, strokeLinecap: 'round' }),
            ),
            h('input', {
              value: query,
              placeholder: '搜索发送人、群名或内容…',
              onChange: (event) => setQuery(event.target.value),
              'aria-label': '搜索消息',
            }),
            query !== ''
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-dt-btn',
                    'data-variant': 'ghost',
                    'data-size': 'sm',
                    style: { height: 22, padding: '0 6px' },
                    onClick: () => setQuery(''),
                  },
                  '×',
                )
              : null,
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              onClick: () => {
                if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                  if (!window.confirm('确定清空本地收件箱记录吗？不会影响钉钉里的消息。')) return
                }
                postAction({ type: 'clear-inbox' })
              },
            },
            '清空',
          ),
        ),

        h(
          'div',
          { className: 'dsh-dt-autocfg', 'data-on': autoReply ? '1' : '0' },
          h(
            'div',
            {
              style: {
                width: 34,
                height: 34,
                borderRadius: 10,
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: autoReply ? 'rgba(46,124,246,.14)' : C.layer2,
                border: `1px solid ${autoReply ? 'rgba(46,124,246,.28)' : C.border1}`,
              },
            },
            h(
              'svg',
              { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
              h('path', {
                d: 'M4 12a8 8 0 1 1 3.1 6.3L4 20l1.2-3.4A7.96 7.96 0 0 1 4 12Z',
                stroke: autoReply ? C.brand : C.sub,
                strokeWidth: 1.7,
                strokeLinejoin: 'round',
              }),
              h('path', {
                d: 'M9 11h6M9 14.5h3.5',
                stroke: autoReply ? C.brand : C.sub,
                strokeWidth: 1.7,
                strokeLinecap: 'round',
              }),
            ),
          ),
          h(
            'div',
            { style: { flex: 1, minWidth: 180 } },
            h(
              'div',
              { className: 'dsh-dt-autocfg-title' },
              '自动回复',
              h(Badge, { tone: autoReply ? 'brand' : 'idle' }, autoReply ? '已开启' : '已关闭'),
            ),
            h(
              'div',
              { className: 'dsh-dt-autocfg-desc' },
              autoReply
                ? `收到消息后由 AI 结合上下文直接回复；置信度低于 ${confidenceText(state && state.minConfidence)} 或判断不明确时，会在主界面弹框请你确认。`
                : '开启后自动判断并回复钉钉消息；关闭时每条消息下方都有独立输入框，可手动选用建议回复。',
            ),
          ),
          h(Switch, { checked: autoReply, onChange: toggleAuto, label: '自动回复开关' }),
          h(
            'div',
            { className: 'dsh-dt-autocfg-extra' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' } },
              h('span', { className: 'dsh-dt-hint', style: { whiteSpace: 'nowrap' } }, '自动回复阈值'),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
                h('input', {
                  className: 'dsh-dt-range',
                  type: 'range',
                  min: 40,
                  max: 100,
                  step: 1,
                  value: thresholdPct,
                  disabled: !autoReply,
                  'aria-label': '自动回复可信度阈值',
                  title: autoReply
                    ? '建议置信度达到该阈值且判断明确时，AI 直接替你回复'
                    : '开启自动回复后才会生效',
                  onChange: (event) => {
                    setDragging(true)
                    previewThreshold(event.target.value)
                  },
                  onPointerUp: (event) => finishThreshold(event.currentTarget.value),
                  onMouseUp: (event) => finishThreshold(event.currentTarget.value),
                  onTouchEnd: (event) => finishThreshold(event.currentTarget.value),
                  onKeyUp: (event) => finishThreshold(event.currentTarget.value),
                  onBlur: (event) => {
                    if (dragging || thresholdDraft !== null) finishThreshold(event.currentTarget.value)
                  },
                }),
                h('div', { className: 'dsh-dt-ticks' }, h('span', null, '40%'), h('span', null, '70%'), h('span', null, '100%')),
              ),
              h('b', { style: { fontSize: 13, fontVariantNumeric: 'tabular-nums', minWidth: 38, color: autoReply ? C.brand : C.sub } }, `${thresholdPct}%`),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 7 } },
              h('span', { className: 'dsh-dt-hint', style: { whiteSpace: 'nowrap' } }, '上下文窗口'),
              h(
                'select',
                {
                  className: 'dsh-dt-select',
                  value: windowMessages,
                  'aria-label': '每个来源保留的上下文条数',
                  title: '每个消息来源（私信按发送人、群 @ 按群）各自保留最近 N 条消息，作为 AI 回复的上下文',
                  onChange: (event) => commitWindow(Number(event.target.value)),
                },
                WINDOW_OPTIONS.map((size) => h('option', { key: size, value: size }, `${size} 条`)),
              ),
            ),
            h('div', { className: 'dsh-dt-spacer' }),
            h(
              'div',
              { className: 'dsh-dt-modelchip', title: modelDetail },
              h('span', { style: { opacity: 0.75 } }, '模型'),
              h('b', null, modelLabel),
            ),
            h(
              'div',
              { className: 'dsh-dt-hint', style: { width: '100%', opacity: autoReply ? 1 : 0.6 } },
              autoReply
                ? `置信度 ≥ ${thresholdPct}% 且模型判断明确时自动发送；低于阈值会弹框请你确认`
                : '阈值仅在开启自动回复后生效',
            ),
            thresholdError !== ''
              ? h('div', { className: 'dsh-dt-hint', style: { width: '100%', color: C.error } }, thresholdError)
              : null,
          ),
        ),

        helpOpen || sources.length === 0
          ? null
          : h(SourceBar, {
              sources,
              total: counts.total,
              value: sourceFilter,
              onChange: setSourceFilter,
            }),

        helpOpen
          ? h(
              'div',
              { className: 'dsh-dt-helpbox' },
              h(
                'div',
                { className: 'dsh-dt-helphead' },
                h('span', { style: { fontSize: 13.5, fontWeight: 680 } }, '使用说明'),
                h('span', { className: 'dsh-dt-hint' }, '只看说明与自动回复设置，收件箱已隐藏'),
                h('div', { className: 'dsh-dt-spacer' }),
                h(
                  Button,
                  { size: 'sm', variant: 'ghost', onClick: () => setHelpOpen(false) },
                  '返回收件箱',
                ),
              ),
              h(HelpContent),
            )
          : null,

        !helpOpen && state && state.inboxNotice
          ? h(
              'div',
              { className: 'dsh-dt-notice', style: { margin: '10px 20px 0' } },
              h('span', null, `ℹ ${state.inboxNotice}`),
            )
          : null,

        helpOpen ? null : h(
          'div',
          {
            className: 'dsh-dt-listbox',
            'data-empty': !state || filtered.length === 0 ? '1' : '0',
          },
          !state
          ? h(
              'div',
              { className: 'dsh-dt-list' },
              error
                ? h(EmptyState, {
                    title: '无法连接插件服务',
                    description: `${error}。请确认插件已在设置中启用，并重启一次 DSH。`,
                  })
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 11 } },
                    h('div', { className: 'dsh-dt-skel' }),
                    h('div', { className: 'dsh-dt-skel' }),
                    h('div', { className: 'dsh-dt-skel' }),
                  ),
            )
          : filtered.length === 0
            ? h(
                'div',
                { className: 'dsh-dt-list' },
                h(EmptyState, {
                  title: messages.length === 0 ? '还没有收到消息' : '当前筛选下没有消息',
                  description:
                    messages.length === 0
                      ? '保持页面打开即可。当有人给你发钉钉私信或在群里 @ 你时，消息会实时出现在这里。'
                      : '试试切换「私信 / 群 @ / 待回复」，或清空搜索与来源筛选。',
                }),
              )
            : h(
                'div',
                { className: 'dsh-dt-list' },
                filtered.map((message) =>
                  h(MessageCard, {
                    key: message.id,
                    message,
                    autoReply,
                    groupReplyAt: state ? state.groupReplyAt !== false : true,
                    busy: busyId === message.id,
                    onSend: handleSend,
                    onRegenerate: handleRegenerate,
                    onDismiss: handleDismiss,
                  }),
                ),
              ),
        ),

        error && state
          ? h(
              'div',
              {
                style: {
                  padding: '8px 20px',
                  borderTop: `1px solid ${C.border1}`,
                  fontSize: 11.5,
                  color: C.error,
                  background: 'rgba(229,72,77,.05)',
                },
              },
              `连接提示：${error}`,
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ 全局弹框

    function AttentionModal() {
      const { state } = useBridge()
      const [index, setIndex] = useState(0)
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)

      const pending = useMemo(() => {
        const messages = state && Array.isArray(state.messages) ? state.messages : []
        return messages.filter(
          (item) => item.needsHuman && !item.dismissed && !(item.reply && item.reply.ok) && item.status !== 'replied',
        )
      }, [state])

      const current = pending.length > 0 ? pending[Math.min(index, pending.length - 1)] : null
      const currentId = current ? current.id : ''

      useEffect(() => {
        setValue('')
      }, [currentId])

      const visible = Boolean(state && state.notifyModal && state.autoReply && current)
      if (!visible) return null

      const suggestion = current.suggestion && current.suggestion.text ? current.suggestion.text : ''
      const text = value.trim() !== '' ? value.trim() : suggestion

      const send = async () => {
        if (text === '' || busy) return
        setBusy(true)
        try {
          await postAction({ type: 'send-reply', id: current.id, text })
          setValue('')
        } finally {
          setBusy(false)
        }
      }

      const dismiss = async () => {
        await postAction({ type: 'dismiss', id: current.id })
        setValue('')
      }

      const regenerate = async () => {
        setBusy(true)
        try {
          await postAction({ type: 'regenerate', id: current.id })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsh-dt-modal-overlay', role: 'dialog', 'aria-modal': 'true' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-dt-modal' },
          h(
            'div',
            { className: 'dsh-dt-modal-title' },
            h('span', { className: 'dsh-dt-dot', 'data-state': 'connecting' }),
            '需要你确认的回复',
            h('div', { className: 'dsh-dt-spacer' }),
            pending.length > 1
              ? h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h(
                    Button,
                    {
                      size: 'sm',
                      variant: 'ghost',
                      onClick: () => setIndex((prev) => (prev + 1) % pending.length),
                    },
                    '下一条',
                  ),
                  h('span', { className: 'dsh-dt-hint' }, `${Math.min(index + 1, pending.length)} / ${pending.length}`),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dsh-dt-modal-sub' },
            `有 `,
            h('b', null, current.sender),
            ` 发送的`,
            h('b', null, current.kind === 'group' ? '群 @ ' : '私信'),
            `消息`,
            current.kind === 'group' && current.conversationTitle
              ? h('span', null, `（${current.conversationTitle}）`)
              : null,
            h('span', { style: { opacity: 0.7 } }, ` · ${timeLabel(current.at)}`),
          ),
          h('div', { className: 'dsh-dt-modal-quote' }, current.text),
          current.images && current.images.length > 0
            ? h(MessageImages, { id: current.id, images: current.images })
            : null,
          suggestion !== ''
            ? h(
                'div',
                { className: 'dsh-dt-hint', style: { marginTop: 10 } },
                `建议回复（置信度 ${confidenceText(current.suggestion.confidence)}）`,
                current.suggestion.reason ? ` · ${String(current.suggestion.reason).slice(0, 80)}` : '',
              )
            : h('div', { className: 'dsh-dt-hint', style: { marginTop: 10 } }, '暂未生成建议，可直接输入回复'),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
            h(GhostInput, {
              value,
              suggestion,
              disabled: busy,
              placeholder: '输入回复，Tab 补全建议…',
              onChange: setValue,
              onSubmit: send,
              ariaLabel: '确认回复内容',
              autoFocus: true,
            }),
            h(
              Button,
              { variant: 'primary', disabled: busy || text === '', onClick: send },
              busy ? '发送中…' : '发送',
            ),
          ),
          h(
            'div',
            { className: 'dsh-dt-modal-foot' },
            h('span', { className: 'dsh-dt-hint' }, 'Tab 补全建议', h('span', { className: 'dsh-dt-kbd' }, 'Enter'), '发送'),
            h('div', { className: 'dsh-dt-spacer' }),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: regenerate }, '换一条建议'),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: dismiss }, '忽略'),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ 授权登录弹框

    function AuthModal() {
      const { state } = useBridge()
      const login = (state && state.login) || null
      const [busy, setBusy] = useState(false)
      // 拿到授权链接就自动打开一次浏览器授权页（弹窗被拦截时弹框里的二维码仍然可用）。
      const openedRef = useRef(false)
      useEffect(() => {
        const pending = login && login.status === 'pending' ? login.url || '' : ''
        if (pending === '' || openedRef.current) return
        openedRef.current = true
        try {
          if (typeof window !== 'undefined') window.open(pending, '_blank', 'noopener,noreferrer')
        } catch {
          // 忽略：用户仍可扫码或点按钮打开。
        }
      }, [login])
      if (!login || (login.status !== 'pending' && login.status !== 'failed')) return null

      const mode = login.mode === 'device' ? 'device' : 'loopback'
      const code = login.code || ''
      const url = login.url || ''
      const qr = login.qr || ''
      const copy = async (text) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text)
          else if (typeof document !== 'undefined') {
            const area = document.createElement('textarea')
            area.value = text
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            document.body.removeChild(area)
          }
        } catch {
          // 复制失败不阻断流程。
        }
      }
      const openUrl = () => {
        if (url === '') return
        try {
          if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
        } catch {
          // 忽略。
        }
      }
      const cancel = async () => {
        setBusy(true)
        try {
          await postAction({ type: 'login-cancel' })
        } finally {
          setBusy(false)
        }
      }

      // 授权失败：留在弹框里说明原因，并给「重试 / 改用二维码」两条路。
      if (login.status === 'failed') {
        return h(
          'div',
          { className: 'dsh-dt-modal-overlay', role: 'dialog', 'aria-modal': 'true' },
          h(Styles),
          h(
            'div',
            { className: 'dsh-dt-modal', style: { maxWidth: '460px' } },
            h(
              'div',
              { className: 'dsh-dt-modal-title' },
              h('span', { className: 'dsh-dt-dot', 'data-state': 'error' }),
              '钉钉授权未完成',
            ),
            h(
              'div',
              { className: 'dsh-dt-modal-sub' },
              login.message || '授权流程没有走完，请重试。',
            ),
            login.error
              ? h('div', { className: 'dsh-dt-hint', style: { marginTop: 8, color: C.error } }, String(login.error))
              : null,
            h(
              'div',
              { style: { marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h(
                Button,
                {
                  variant: 'primary',
                  disabled: busy,
                  onClick: async () => {
                    setBusy(true)
                    try {
                      await postAction({ type: 'login-start' })
                    } finally {
                      setBusy(false)
                    }
                  },
                },
                login.mode === 'device' ? '重新获取二维码' : '再试一次',
              ),
              h('div', { className: 'dsh-dt-spacer' }),
              h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: cancel }, '关闭'),
            ),
            h(
              'div',
              { className: 'dsh-dt-modal-foot' },
              h(
                'span',
                { className: 'dsh-dt-hint' },
                login.mode === 'device'
                  ? '也可以把配置项 loginMode 改回 loopback，用浏览器扫码授权（不需要授权码）。'
                  : '浏览器打不开或回调端口被拦截时，可把配置项 loginMode 改成 device，用二维码 + 授权码授权。',
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsh-dt-modal-overlay', role: 'dialog', 'aria-modal': 'true' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-dt-modal', style: { maxWidth: '460px' } },
          h(
            'div',
            { className: 'dsh-dt-modal-title' },
            h('span', { className: 'dsh-dt-dot', 'data-state': 'connecting' }),
            '钉钉授权登录',
            h('div', { className: 'dsh-dt-spacer' }),
            h(Badge, { tone: 'brand' }, '等待授权'),
          ),
          h('div', { className: 'dsh-dt-modal-sub' }, login.message || '点击下方按钮，在弹出的钉钉页面里扫码或登录即可完成授权'),
          mode === 'device'
            ? qr !== ''
              ? h(
                  'div',
                  { className: 'dsh-dt-qrwrap', style: { marginTop: 12 } },
                  h('img', { className: 'dsh-dt-qr', src: qr, alt: '钉钉授权二维码' }),
                  h('div', { className: 'dsh-dt-hint', style: { textAlign: 'center' } }, '打开钉钉扫一扫，确认授权即可'),
                )
              : h('div', { className: 'dsh-dt-skel', style: { height: 168, marginTop: 12, borderRadius: 12 } })
            : h(
                'div',
                { className: 'dsh-dt-auth', style: { marginTop: 12 } },
                h('div', { className: 'dsh-dt-auth-icon' }, '①'),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontWeight: 600, fontSize: 13 } }, '在浏览器里完成一次授权'),
                  h(
                    'div',
                    { className: 'dsh-dt-hint', style: { marginTop: 3 } },
                    '用钉钉扫码或输入账号密码登录，授权页会回调本机端口自动完成登录。',
                  ),
                  h(
                    'div',
                    { className: 'dsh-dt-hint', style: { marginTop: 2, color: C.success, fontWeight: 600 } },
                    '不需要输入任何授权码',
                  ),
                ),
                h(Button, { variant: 'primary', disabled: url === '', onClick: openUrl }, '打开钉钉授权页面'),
              ),
          h(
            'div',
            { style: { marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            mode === 'device'
              ? h(Button, { variant: 'primary', disabled: url === '', onClick: openUrl }, '用浏览器打开授权页面')
              : h('span', { className: 'dsh-dt-hint' }, '页面没弹出来？点「复制链接」粘到浏览器打开。'),
            h('div', { className: 'dsh-dt-spacer' }),
            url !== '' && mode !== 'device'
              ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => copy(url) }, '复制链接')
              : null,
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: cancel }, '取消'),
          ),
          mode === 'device' && (code !== '' || url !== '')
            ? h(
                'details',
                { style: { marginTop: 10 } },
                h(
                  'summary',
                  { className: 'dsh-dt-hint', style: { cursor: 'pointer' } },
                  '扫码不方便？手动输入授权码',
                ),
                code !== ''
                  ? h('div', { className: 'dsh-dt-modal-code', style: { marginTop: 8 } }, code)
                  : null,
                url !== ''
                  ? h(
                      'a',
                      {
                        className: 'dsh-dt-modal-link',
                        style: { marginTop: 8, display: 'block' },
                        href: url,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      },
                      url,
                    )
                  : null,
                h(
                  'div',
                  { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  code !== ''
                    ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => copy(code) }, '复制授权码')
                    : null,
                  url !== ''
                    ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => copy(url) }, '复制链接')
                    : null,
                ),
              )
            : null,
          h(
            'div',
            { className: 'dsh-dt-modal-foot' },
            h(
              'span',
              { className: 'dsh-dt-hint' },
              mode === 'device'
                ? '在钉钉里确认后，本窗口会自动关闭并开始实时接收消息（二维码约 15 分钟内有效）。'
                : '授权页会回调本机端口自动完成登录，之后本窗口自动关闭并开始实时接收消息（链接约 15 分钟内有效）。',
            ),
          ),
        ),
      )
    }

    function GlobalOverlay() {
      const { state } = useBridge()
      // 待确认弹框优先：已经在等用户确认回复时，不再用授权弹框抢焦点。
      const attention = useMemo(() => {
        const messages = state && Array.isArray(state.messages) ? state.messages : []
        return messages.some(
          (item) => item.needsHuman && !item.dismissed && !(item.reply && item.reply.ok) && item.status !== 'replied',
        )
      }, [state])
      const attentionVisible = Boolean(state && state.notifyModal && state.autoReply && attention)
      return h('div', null, h(AttentionModal), attentionVisible ? null : h(AuthModal))
    }

    // ------------------------------------------------------------------ 设置页 / 配置卡片

    function SettingsCard() {
      const { state, error } = useBridge()
      const summary = listenerSummary(state)
      const model = (state && state.model) || null
      const modelText =
        model && model.model
          ? `${model.model}（${model.provider || '未知 provider'}）`
          : state && state.autoSuggest
            ? '跟随 DSH 当前模型（未读取到）'
            : '已关闭自动生成'
      const login = (state && state.login) || null
      const loginText =
        state && Array.isArray(state.profiles) && state.profiles.length > 0
          ? `已登录${state.selfName ? `：${state.selfName}` : ''}`
          : login && login.status === 'pending'
            ? '等待授权中…'
            : login && login.status === 'failed'
              ? `授权失败：${login.message || login.error || '请重试'}`
              : '未登录，请点击「钉钉授权」'
      const rows = [
        ['连接状态', `${summary.text}${summary.detail ? ` · ${summary.detail}` : ''}`],
        ['钉钉授权', loginText],
        ['当前账号', (state && state.selfName) || h('span', { style: { color: C.sub } }, '未读取到')],
        ['组织 profile', (state && state.currentProfile) || h('span', { style: { color: C.sub } }, '未登录或未读取到')],
        [
          '已登录组织',
          state && Array.isArray(state.profiles) && state.profiles.length > 0
            ? `${state.profiles.length} 个${
                state.expiredProfiles && state.expiredProfiles.length > 0
                  ? `（${state.expiredProfiles.length} 个登录已过期，建议重新授权）`
                  : ''
              }`
            : '0 个',
        ],
        ['重新授权前先退出旧组织', state ? (state.loginReset === false ? '已关闭（会保留旧组织、追加新组织）' : '已开启（只保留本次新授权的组织）') : '—'],
        ['自动回复', state ? (state.autoReply ? '已开启（AI 判断后自动发送）' : '已关闭（逐条手动确认）') : '—'],
        ['自动回复阈值', state ? `${confidenceText(state.minConfidence)}（收件箱顶部可调）` : '—'],
        ['建议回复模型', modelText],
        [
          '图片识别',
          state
            ? state.imageRecognition
              ? `已开启（每条最多 ${state.imageMax || 2} 张）${imageCapabilityText(state)}`
              : '已关闭（图片只显示不分析）'
            : '—',
        ],
        [
          '上下文来源',
          state
            ? state.remoteContext
              ? `钉钉最新 ${state.remoteContextLimit || 10} 条 + 本地记录，共取 ${state.contextMessages || 6} 条`
              : `仅本地记录，取 ${state.contextMessages || 6} 条`
            : '—',
        ],
        [
          '上下文窗口',
          state
            ? `每个来源独立维护最近 ${state.windowMessages || 5} 条（当前已跟踪 ${state.windowCount || 0} 个来源），新消息自动滑入、最早的滑出（收件箱顶部可调）`
            : '—',
        ],
        [
          '群 @ 回复',
          state ? (state.groupReplyAt === false ? '已关闭（群回复不再 @ 发送人）' : '已开启（群回复先 @ 回发送人）') : '—',
        ],
        [
          '连续多条',
          state
            ? state.multiSend === false
              ? '已关闭（一次只发一条）'
              : `已开启（最多 ${state.multiSendMax || 5} 条，间隔 ${state.multiSendDelayMs || 600}ms）`
            : '—',
        ],
        ['dws 版本', state && state.tool && state.tool.version ? state.tool.version : '未检测到'],
        [
          'dws 安装状态',
          state && state.install
            ? state.install.status === 'ready'
              ? `已就绪（v${state.install.currentVersion || state.tool?.version || '?'}）${
                  state.install.latestVersion && state.install.latestVersion !== state.install.currentVersion
                    ? `，npm 上最新 v${state.install.latestVersion}`
                    : ''
                }`
              : state.install.status === 'installing'
                ? `安装中（${state.install.targetVersion ? `v${state.install.targetVersion}，` : ''}${state.install.source || '...'}）`
                : state.install.status === 'missing'
                  ? '未安装（可点上方「安装 dws」自动安装）'
                  : state.install.status === 'error'
                    ? '安装 / 更新失败（可查看日志后重试）'
                    : '检测中'
            : '—',
        ],
        [
          'npm 安装源',
          state && state.install && state.install.source ? state.install.source : 'https://registry.npmjs.org/',
        ],
        [
          '宿主版本',
          state && state.build
            ? String(state.build).indexOf(CLIENT_BUILD) === 0
              ? state.build
              : `${state.build}（与界面 ${CLIENT_BUILD} 不一致，请重启 DSH）`
            : '未上报（宿主代码较旧）',
        ],
        [
          '最近请求',
          state && state.lastError
            ? h('span', { style: { color: C.error } }, state.lastError)
            : state && Array.isArray(state.requests) && state.requests.length > 0
              ? `${state.requests[state.requests.length - 1].method} → ${state.requests[state.requests.length - 1].status}`
              : '—',
        ],
        ['消息保留', '本地保留最近若干条，可随时在收件箱清空'],
      ]

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { fontSize: 13.5, fontWeight: 650 } }, '钉钉消息自动化'),
        h(
          'div',
          { style: { fontSize: 12, color: C.sub, marginTop: 4, lineHeight: 1.6 } },
          '实时接收钉钉私信与群 @ 消息，按发送人记录来源；AI 生成建议回复，可选择自动回复或逐条确认。',
        ),
        // 页面最顶端展示当前建议回复所用的模型（实时跟随 DSH 平台模型）。
        h(
          'div',
          { className: 'dsh-dt-modelchip', style: { marginTop: 10, alignSelf: 'flex-start' } },
          h('span', { style: { opacity: 0.75 } }, '当前使用模型'),
          h('b', null, modelText),
        ),
        h(
          'dl',
          { className: 'dsh-dt-kv' },
          rows.map(([key, value]) =>
            h('div', { key, style: { display: 'contents' } }, h('dt', null, key), h('dd', null, value)),
          ),
        ),
        error
          ? h('div', { style: { fontSize: 12, color: C.error, marginTop: 10 } }, `连接提示：${error}`)
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } },
          h(
            Button,
            { size: 'sm', variant: 'primary', onClick: () => postAction({ type: 'login-start' }) },
            '钉钉授权 / 重新登录',
          ),
          state && Array.isArray(state.profiles) && state.profiles.length > 0
            ? h(Button, { size: 'sm', onClick: () => postAction({ type: 'logout' }) }, '退出钉钉登录')
            : null,
          h(Button, { size: 'sm', onClick: () => postAction({ type: 'refresh' }) }, '刷新状态'),
          h(Button, { size: 'sm', onClick: () => postAction({ type: 'restart-listeners' }) }, '重启监听'),
        ),
        h('div', { style: { fontSize: 12, fontWeight: 620, marginTop: 18 } }, '使用说明'),
        h(HelpContent),
        h(
          'div',
          { style: { fontSize: 11.5, color: C.sub, marginTop: 14, lineHeight: 1.6 } },
          '详细文档见插件目录 docs/使用说明.md；配置项在下方「插件配置」中修改后需重启 DSH 生效。',
        ),
      )
    }

    function SettingsSection() {
      return h('div', { style: { padding: '4px 0' } }, h(Styles), h(SettingsCard))
    }

    function PluginConfigCard() {
      return h(
        'div',
        { style: { padding: '2px 0' } },
        h(Styles),
        h(
          'div',
          { style: { fontSize: 12, color: C.sub, marginBottom: 10, lineHeight: 1.6 } },
          '以下为宿主侧配置（监听开关、置信度阈值、模型选择等），保存后需重启 DSH 生效；收件箱顶部的「自动回复」开关可在运行时即时切换。',
        ),
        h(SettingsCard),
      )
    }

    // ------------------------------------------------------------------ 品牌图标

    const ICON_URL = `${API}/icon`

    /**
     * 插件图标：优先用 icon.png 里的彩色机器人图（由宿主 GET /icon 提供），
     * 加载失败时退回单色矢量图，保证任何主题下都有图标可看。
     */
    function BrandIcon(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 18
      const [failed, setFailed] = useState(false)
      const radius = Math.max(4, Math.round(size * 0.26))
      if (!failed) {
        return h('img', {
          src: ICON_URL,
          width: size,
          height: size,
          alt: '钉钉消息自动化',
          draggable: false,
          onError: () => setFailed(true),
          style: {
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: `${radius}px`,
            objectFit: 'cover',
            display: 'block',
            flex: 'none',
            boxShadow: '0 1px 3px rgba(16,24,40,.22)',
          },
        })
      }
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 48 48',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M24 4C12.4 4 3 12.2 3 22.3c0 5.7 3 10.8 7.8 14.2v7.4c0 .9 1 1.4 1.7.9l8.1-5.3c1.1.2 2.3.3 3.4.3 11.6 0 21-8.2 21-18.3S35.6 4 24 4Z',
          fill: 'currentColor',
          fillOpacity: 0.16,
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 31.5, cy: 15.5, r: 5, fill: 'currentColor' }),
        h('circle', { cx: 31.5, cy: 15.5, r: 1.6, fill: 'var(--dsw-alias-bg-base, #fff)' }),
      )
    }

    // ------------------------------------------------------------------ 侧边栏图标

    function SidebarIcon(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 18
      return h(BrandIcon, { size })
    }

    // ------------------------------------------------------------------ 注册

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 46, label: '钉钉消息自动化' },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, InboxPanel),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dingtalk-attention', order: 80, label: '钉钉待确认回复' },
            GlobalOverlay,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dingtalk-bridge-settings', order: 42, label: '钉钉消息自动化' },
            SettingsSection,
          ),
        )

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, PluginConfigCard),
        )
      },
    }
  },
})


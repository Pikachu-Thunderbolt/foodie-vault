'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
let cloud
if (process.env.USE_LOCAL_CLOUD === 'true') {
  // 显式本地模式：即使装了 wx-server-sdk 也用文件版假云，确定性最强，便于本地测试。
  cloud = require('./local-cloud').createLocalCloud(path.resolve(__dirname, '../data'))
  console.warn('[paoding-jieniu] USE_LOCAL_CLOUD=true，已启用本地文件版云替身')
} else {
  try { cloud = require('wx-server-sdk') } catch (_) {
    cloud = require('./local-cloud').createLocalCloud(path.resolve(__dirname, '../data'))
    console.warn('[paoding-jieniu] wx-server-sdk 未安装，已回退本地文件版云替身（可设 USE_LOCAL_CLOUD=true 显式启用）')
  }
}
const { RecipePublisher } = require('./publisher')
const { ValidationError } = require('./validator')
const { TutorialService } = require('./tutorials')

const port = Number(process.env.PORT || 8080)
const host = process.env.HOST || '127.0.0.1'
const ingestRoot = path.resolve(process.env.INGEST_ROOT || '/data/recipe-ingest/outgoing')
const token = process.env.INGEST_API_TOKEN || ''
const dashboardUser = process.env.DASHBOARD_USER || ''
const dashboardPassword = process.env.DASHBOARD_PASSWORD || ''
const dashboardSessionSecret = process.env.DASHBOARD_SESSION_SECRET || dashboardPassword
const watch = process.env.WATCH_INGEST_ROOT === 'true'
const intervalMs = Math.max(5000, Number(process.env.WATCH_INTERVAL_MS || 15000))

if (process.env.NODE_ENV === 'production' && !token) throw new Error('生产环境必须设置 INGEST_API_TOKEN')
cloud.init({ env: process.env.CLOUDBASE_ENV || cloud.DYNAMIC_CURRENT_ENV })
const publisher = new RecipePublisher({ cloud, ingestRoot })
const tutorials = new TutorialService({ cloud })

// 候选帧 cloudFileId → 可显示 URL（本地假云走 /__localmedia，生产走云临时 URL）。
async function resolveTempUrls(fileIds) {
  const unique = [...new Set((fileIds || []).filter(Boolean))]
  if (!unique.length || typeof cloud.getTempFileURL !== 'function') return {}
  try {
    const res = await cloud.getTempFileURL({ fileList: unique })
    const map = {}
    for (const item of res.fileList || []) if (item.fileID && item.tempFileURL) map[item.fileID] = item.tempFileURL
    return map
  } catch (_) { return {} }
}

function reply(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function isAuthorized(req) {
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`
}

function isDashboardAuthorized(req) {
  if (!dashboardUser || !dashboardPassword) return isAuthorized(req)
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((item) => item.trim().split(/=(.*)/s)).filter(([key]) => key))
  const token = cookies.paoding_session
  if (!token || !dashboardSessionSecret) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false
  const expected = crypto.createHmac('sha256', dashboardSessionSecret).update(payload).digest('base64url')
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return session.user === dashboardUser && Number(session.exp) > Date.now()
  } catch (_) { return false }
}

function createDashboardSession() {
  const payload = Buffer.from(JSON.stringify({ user: dashboardUser, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url')
  const signature = crypto.createHmac('sha256', dashboardSessionSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function html(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]))
}

function loginPage(error = '') {
  const errorHtml = error ? `<div class="error" role="alert">账号或密码不正确，请检查后重试。</div>` : ''
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 庖丁解牛</title><style>
  :root{--ink:#29201b;--muted:#786b60;--paper:#fffdf8;--line:#e8ddcb;--coral:#cc6049;--coral-dark:#ad4d39}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 15%,#fff9ed 0,transparent 34%),linear-gradient(145deg,#f5efe5,#ece1d0);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--ink)}main{width:min(100%,440px)}.brand{display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:24px;font-weight:760;letter-spacing:.08em}.mark{width:40px;height:40px;border-radius:13px;background:#d96d54;display:grid;place-items:center;box-shadow:0 7px 18px #bb776a55}.mark svg{width:24px;height:24px;stroke:#fff}.card{background:#fffdf8;border:1px solid var(--line);border-radius:20px;padding:34px;box-shadow:0 24px 60px #765b4330}.eyebrow{font-size:12px;letter-spacing:.12em;color:#a65945;font-weight:750}.card h1{font-size:28px;margin:7px 0 8px}.sub{color:var(--muted);line-height:1.65;margin:0 0 26px}label{display:block;font-size:14px;font-weight:650;margin:17px 0 7px}input{width:100%;height:48px;border:1px solid #cfc1ad;border-radius:10px;padding:0 13px;font:inherit;color:var(--ink);background:#fff;outline:none}input:focus{border-color:#b65542;box-shadow:0 0 0 3px #e9a08c55}.password-wrap{position:relative}.password-wrap button{position:absolute;right:6px;top:6px;height:36px;border:0;background:transparent;color:#765d4d;font:inherit;padding:0 9px;cursor:pointer}.primary{margin-top:26px;width:100%;min-height:48px;border:0;border-radius:11px;background:var(--coral);color:#fff;font:650 16px inherit;cursor:pointer;box-shadow:0 7px 14px #b3513b44;transition:transform .18s ease,background .18s ease}.primary:hover{background:var(--coral-dark)}.primary:active{transform:translateY(1px)}.primary:focus-visible,.password-wrap button:focus-visible{outline:3px solid #eaa18d;outline-offset:2px}.hint{margin:20px 0 0;text-align:center;font-size:12px;color:#8b7c70}.error{background:#fff0ec;color:#9e3e2e;border:1px solid #efc2b7;padding:10px 12px;border-radius:9px;font-size:14px;margin-bottom:16px}@media(max-width:480px){body{padding:16px}.card{padding:28px 22px}}</style>
  <main><div class="brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M4 10h16M6 10l1.2 9h9.6l1.2-9M9 6a3 3 0 0 1 6 0"/><path d="M9 14h6"/></svg></span><span>庖丁解牛 · 内容后台</span></div><section class="card" aria-labelledby="login-title"><div class="eyebrow">ADMIN CONSOLE</div><h1 id="login-title">欢迎回来</h1><p class="sub">登录后可管理 B站教程、处理任务、审核、发布和版本记录。</p>${errorHtml}<form method="post" action="/dashboard/login"><label for="username">后台账号</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">密码</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" required><button type="button" aria-label="显示或隐藏密码" onclick="const i=document.getElementById('password');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'显示':'隐藏'">显示</button></div><button class="primary" type="submit">进入内容后台</button></form><p class="hint">仅授权内容管理员可访问</p></section></main></html>`
}

const STATUS_CN = {
  PREFLIGHT_PENDING: '待预检', PREFLIGHT_PASSED: '预检通过', PREFLIGHT_REJECTED: '预检拒绝',
  PREFLIGHT_MANUAL_REVIEW: '待人工预检', PROCESSING: '处理中', QUEUED: '排队中',
  DOWNLOADING: '下载中', TRANSCRIBING: '转写中', EXTRACTING: '提取中',
  FRAMES_EXTRACTED: '帧已提取', FRAMES_REVIEW: '待挑帧', READY_TO_EXPORT: '待导出',
  EXPORTING: '导出中', SYSTEM_REVIEW_REQUIRED: '待系统审核', OWNER_REVIEW_REQUIRED: '待自审',
  OWNER_APPROVED: '自审通过', PUBLISHED: '已发布', REJECTED: '已拒绝',
  PROCESSING_FAILED: '处理失败', NOT_QUEUED: '未入队', READY_TO_QUEUE: '待入队',
  BLOCKED: '已拦截', COMPLETE: '已完成', METADATA_INCOMPLETE: '元数据不完整',
  MANUAL_REVIEW_REQUIRED: '待人工预检',
}
const OWNER_CN = { SYSTEM: '系统发现', USER: '用户提交' }
function cnStatus(s) { return STATUS_CN[s] || s }
function cnOwner(o) { return OWNER_CN[o] || o }

function badge(value) {
  const cnClass = (STATUS_CN[value] || value || '').toLowerCase().replace(/\s+/g, '_')
  const ownerClass = (OWNER_CN[value] || '').toLowerCase().replace(/\s+/g, '_')
  const cls = [html(String(value)).toLowerCase(), cnClass, ownerClass].filter(Boolean).join(' ')
  return `<span class="badge ${cls}">${html(cnStatus(value) || cnOwner(value) || value || '—')}</span>`
}
function dashboardPage(tutorialRows, filter = {}) {
  const filterBar = `
    <form method="get" action="/dashboard" class="filter-bar">
      <select name="channelType"><option value="">全部渠道</option>${require('./channels').listChannels().map(ch => `<option value="${html(ch.channelType)}" ${filter.channelType===ch.channelType?'selected':''}>${html(ch.label)}</option>`).join('')}</select>
      <select name="status"><option value="">全部状态</option>
        ${['PREFLIGHT_PASSED','PROCESSING','FRAMES_REVIEW','SYSTEM_REVIEW_REQUIRED','OWNER_REVIEW_REQUIRED','PUBLISHED','REJECTED'].map(s => `<option value="${s}" ${filter.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <select name="ownerType"><option value="">全部归属</option><option value="SYSTEM" ${filter.ownerType==='SYSTEM'?'selected':''}>系统发现</option><option value="USER" ${filter.ownerType==='USER'?'selected':''}>用户提交</option></select>
      <button type="submit">筛选</button>
    </form>`

  const table = tutorialRows.map(t => `<tr>
    <td><a href="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}">${html(t.sourceTitle || t.sourceId)}</a><br><small>${html(t.channelType)} · ${html(t.sourceId)}</small></td>
    <td>${badge(t.ownerType)}</td>
    <td>${badge(t.lifecycleStatus)}</td>
    <td>${badge(t.visibility)}</td>
    <td>${t.currentVersionId ? html(String(t.revisionCount || 1)) : '—'}</td>
    <td>${t.updatedAt ? html(String(t.updatedAt).slice(0,19)) : '—'}</td>
  </tr>`).join('')

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>庖丁解牛 · 教程库</title><style>
  :root{--ink:#342a24;--paper:#fffaf0;--line:#eadcc8;--coral:#d9694d;--green:#618c55;--amber:#b87825}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;background:#f8f1e4;color:var(--ink)}main{max-width:1240px;margin:auto;padding:32px 22px 64px}.hero{padding:24px 28px;border:1px solid var(--line);background:linear-gradient(135deg,#fffdf6,#fff5e7);border-radius:18px;margin-bottom:22px}.eyebrow{color:var(--coral);font-weight:700;letter-spacing:.12em;font-size:12px}.hero h1{margin:7px 0;font-size:30px}.sub{color:#806f61;line-height:1.6;margin:0}nav{display:flex;gap:18px;margin:20px 0;font-weight:700}nav a{color:var(--ink);text-decoration:none}nav a.active{color:var(--coral)}section{background:#fffdf8;border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0;overflow:auto}h2{font-size:18px;margin:0 0 5px}.filter-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.filter-bar select{height:36px;border:1px solid #cfc1ad;border-radius:8px;padding:0 8px;font:inherit}.filter-bar button{background:var(--coral);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer}table{width:100%;border-collapse:collapse;min-width:700px}th,td{padding:10px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:top}th{color:#806f61;font-weight:600;background:#fff8ec}.badge{font-size:11px;border-radius:999px;padding:3px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap}.badge.PUBLISHED,.badge.SYSTEM,.badge.PREFLIGHT_PASSED{background:#e4f1df;color:#417138}.badge.REJECTED,.badge.PREFLIGHT_REJECTED{background:#f9dfd8;color:#a8432f}.badge.PROCESSING,.badge.FRAMES_REVIEW,.badge.SYSTEM_REVIEW_REQUIRED,.badge.OWNER_REVIEW_REQUIRED{background:#fff0d4;color:#9a661a}.badge.PREFLIGHT_PENDING{background:#eee3d2;color:#5c4b3f}a{color:#bd573f}@media(max-width:700px){main{padding:16px}.hero{padding:18px}}</style>
  <main><div class="hero"><div class="eyebrow">庖丁解牛 · 内容控制台</div><h1>教程库</h1><p class="sub">多渠道做饭教程的发现、拆解、审核与发布。统一管理每个教程的完整生命周期。</p><form method="post" action="/dashboard/logout" style="margin-top:14px"><button style="border:0;background:none;padding:0;color:#8a6554;text-decoration:underline;cursor:pointer">退出登录</button></form></div><nav><a class="active" href="/dashboard">教程库</a><a href="/dashboard/discover">素材工作台</a><a href="/dashboard/dictionary">菜品字典</a></nav>
  <section>${filterBar}<table><thead><tr><th>教程 / 来源</th><th>归属</th><th>状态</th><th>可见性</th><th>版本数</th><th>最近更新</th></tr></thead><tbody>${table || '<tr><td colspan="6">暂无教程。去<a href="/dashboard/discover">素材工作台</a>添加。</td></tr>'}</tbody></table></section></main></html>`
}

function dashboardDetailPage(detail) {
  const publish = detail.job.status === 'WAITING_REVIEW' ? `<form method="post" action="/dashboard/recipes/${encodeURIComponent(detail.job.recipeId)}/publish"><button>审核并公开发布</button></form>` : ''
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>处理包详情</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026}pre{white-space:pre-wrap;word-break:break-word;background:#fff;padding:20px;border:1px solid #eadfce;border-radius:8px}a{color:#c9573b}button{background:#dd6b4a;color:white;border:0;border-radius:6px;padding:10px 16px}</style><p><a href="/dashboard">← 返回发布台</a></p><h1>${html(detail.job.packageId)}</h1><p>本地包状态：<strong>${html(detail.localPackageState)}</strong>；归档 manifest：${html(detail.job.manifestCloudFileId || '尚未归档')}</p>${publish}<pre>${html(JSON.stringify(detail, null, 2))}</pre></html>`
}

function dashboardTutorialPage(detail) {
  const t = detail.tutorial
  const revisions = detail.revisions || []
  // 生命周期动作条：预检通过可入队；抽帧完成(系统教程)可去挑帧。
  const actions = []
  if (t.lifecycleStatus === 'PREFLIGHT_PASSED') actions.push(`<form method="post" action="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}/enqueue" style="display:inline"><button style="background:#618c55;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer">入队处理</button></form>`)
  if (t.lifecycleStatus === 'FRAMES_REVIEW' && t.ownerType === 'SYSTEM') actions.push(`<a href="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}/frames" style="display:inline-block;background:#d9694d;color:#fff;border-radius:8px;padding:8px 14px;text-decoration:none">去挑代表帧</a>`)
  if (t.lifecycleStatus === 'FRAMES_REVIEW' && t.ownerType === 'USER') actions.push('<span class="warn">等待用户在小程序内挑选代表帧</span>')
  const actionBar = actions.length ? `<p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${actions.join('')}</p>` : ''
  // 系统审核：待系统审核的版本给「通过 / 拒绝」按钮；通过前会由控制面校验来源授权 cleared。
  const rows = revisions.map((r) => {
    const canSystemReview = r.reviewStatus === 'SYSTEM_REVIEW_REQUIRED'
    const controls = canSystemReview
      ? `<form method="post" action="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}/review" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="hidden" name="versionId" value="${html(r.versionId)}">
          <input name="reason" placeholder="拒绝理由（可选）" style="height:34px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px">
          <button name="action" value="SYSTEM_APPROVE" style="background:#618c55;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer">系统通过发布</button>
          <button name="action" value="REJECT" style="background:#ad4d39;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer">拒绝</button>
         </form>`
      : ''
    return `<tr><td>v${html(r.versionNumber)}</td><td>${badge(r.reviewStatus)}</td><td>${badge(r.releaseStatus || '')}</td><td>${html(r.requestedVisibility || '')}</td><td>${html(r.changeSummary || '')}</td><td>${controls}</td></tr>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>庖丁解牛 · 教程详情</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026;line-height:1.6}main{max-width:960px;margin:auto}pre{white-space:pre-wrap;word-break:break-word;background:#fff;padding:18px;border:1px solid #eadfce;border-radius:12px}a{color:#c9573b}h1{margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{padding:10px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:middle}th{color:#806f61;background:#fff8ec}.badge{font-size:11px;border-radius:999px;padding:4px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap}.badge.published,.badge.system_approved,.badge.owner_approved{background:#e4f1df;color:#417138}.badge.rejected{background:#f9dfd8;color:#a8432f}.badge.system_review_required,.badge.owner_review_required{background:#fff0d4;color:#9a661a}.warn{background:#fff0ec;color:#9e3e2e;border:1px solid #efc2b7;padding:8px 12px;border-radius:9px;font-size:13px}</style><main><p><a href="/dashboard">← 返回庖丁解牛后台</a></p><h1>${html(t.sourceTitle || t.sourceId)}</h1><p>来源：${html(t.channelType)} · <a target="_blank" href="${html(t.sourceUrl)}">${html(t.sourceId)}</a> · ${badge(t.ownerType)} · ${badge(t.lifecycleStatus)} · 可见性 ${badge(t.visibility)}</p><p>来源授权：<strong>${html(t.sourceRightsStatus || 'unknown')}</strong>${t.sourceRightsStatus !== 'cleared' ? '<span class="warn" style="margin-left:8px">系统发布/分享要求来源授权为 cleared</span>' : ''}</p>${actionBar}
  <h2>版本与审核</h2><table><thead><tr><th>版本</th><th>审核状态</th><th>发布状态</th><th>申请可见性</th><th>变更说明</th><th>系统审核操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6">尚无处理版本</td></tr>'}</tbody></table>
  <h2>处理任务与审计历史</h2><pre>${html(JSON.stringify({ tasks: detail.tasks, events: detail.events }, null, 2))}</pre></main></html>`
}

function dashboardDiscoverPage(message, channelType = 'bilibili', activeSopTab = 'discover', activeSubTab = 'ranking', results = [], upsList = []) {
  const channels = require('./channels').listChannels()
  const channel = require('./channels').getChannel(channelType)
  const modes = channel.discovery.modes

  const note = message ? `<div class="msg">${html(message)}</div>` : ''

  // ── Level-1 SOP Tabs ──
  const sopTab = (key, label) => {
    const q = new URLSearchParams({ channel: channelType, sop: key, sub: key === 'discover' ? activeSubTab : '' }).toString()
    return `<a href="?${q}" class="sop-tab ${key === activeSopTab ? 'active' : ''}">${label}</a>`
  }
  const sopTabs = `<div class="sop-tabs">${sopTab('discover', '发现素材')}${sopTab('processing', '待处理')}${sopTab('publish', '待发布')}</div>`

  // ── Level-2 Sub Tabs (only for discover) ──
  let subTabs = ''
  if (activeSopTab === 'discover') {
    const subTab = (key, label) => {
      const q = new URLSearchParams({ channel: channelType, sop: 'discover', sub: key }).toString()
      return `<a href="?${q}" class="sub-tab ${key === activeSubTab ? 'active' : ''}">${label}</a>`
    }
    subTabs = `<div class="sub-tabs">${subTab('ranking', '榜单发现')}${subTab('up_subscription', 'UP主关注')}${subTab('direct', '指定素材')}</div>`
  }

  // ═══════════════════════════════════════════════════════
  // SOP Tab 1: 发现素材
  // ═══════════════════════════════════════════════════════
  let discoverContent = ''
  if (activeSopTab === 'discover') {
    // Channel selector
    const channelOpts = channels.map(ch =>
      `<option value="${html(ch.channelType)}" ${ch.channelType === channelType ? 'selected' : ''}>${html(ch.label)}</option>`
    ).join('')
    const channelBar = `
      <div class="channel-bar">
        <span>渠道</span>
        <form method="get" action="/dashboard/discover" style="display:inline">
          <select name="channel" onchange="this.form.submit()">${channelOpts}</select>
          <input type="hidden" name="sop" value="discover">
          <input type="hidden" name="sub" value="${html(activeSubTab)}">
        </form>
      </div>`

    // --- Sub-tab: 榜单发现 ---
    let rankingForm = ''
    if (activeSubTab === 'ranking') {
      const rankingMode = modes.find(m => m.key === 'ranking')
      rankingForm = `
      <section>
        <h2>榜单发现</h2>
        <form method="post" action="/dashboard/discover/run" class="inline-form">
          <input type="hidden" name="channelType" value="${html(channelType)}">
          <label>来源</label>
          <select name="source">
            ${(rankingMode.params[0].options || []).map(o =>
              `<option value="${html(o.value)}">${html(o.label)}</option>`).join('')}
          </select>
          <label>数量</label><input name="limit" value="30" style="width:70px">
          <button type="submit">开始发现</button>
        </form>
      </section>`
    }

    // --- Sub-tab: UP主关注 ---
    let upsForm = ''
    if (activeSubTab === 'up_subscription') {
      upsForm = `
      <section>
        <h2>UP主关注</h2>
        <form method="post" action="/dashboard/ups/add" class="inline-form">
          <label>添加UP主（mid或空间链接）</label>
          <input name="mid" placeholder="64876543 或 space.bilibili.com/64876543" style="width:300px">
          <button type="submit">关注</button>
        </form>
        <form method="post" action="/dashboard/ups/crawl" style="margin-top:8px">
          <button type="submit" style="background:#618c55">一键拉取所有UP主新视频</button>
        </form>
      </section>`
      if (upsList.length > 0) {
        const upsRows = upsList.map(u => `<tr>
          <td><strong>${html(u.name || 'UP_'+u.mid)}</strong><br><small>mid: ${html(String(u.mid))}</small></td>
          <td>${u.n_approved || 0}✓ / ${u.n_pending || 0}… / ${u.n_total || 0}总</td>
          <td>${u.last_checked_at ? String(u.last_checked_at).slice(0,19) : '—'}</td>
          <td>${u.last_video_bvid ? `<a target="_blank" href="https://www.bilibili.com/video/${html(u.last_video_bvid)}">${html(u.last_video_bvid)}</a>` : '—'}</td>
          <td><form method="post" action="/dashboard/ups/remove" onsubmit="return confirm('取消关注？')"><input type="hidden" name="mid" value="${html(String(u.mid))}"><button class="btn-sm" style="background:#ad4d39">取消关注</button></form></td>
        </tr>`).join('')
        upsForm += `
        <section>
          <h2>已关注 ${upsList.length} 个UP主</h2>
          <table><thead><tr><th>UP主</th><th>视频统计</th><th>上次检查</th><th>最新视频</th><th>操作</th></tr></thead>
          <tbody>${upsRows}</tbody></table>
        </section>`
      }
    }

    // --- Sub-tab: 指定素材 ---
    let directForm = ''
    if (activeSubTab === 'direct') {
      directForm = `
      <section>
        <h2>指定素材</h2>
        <form method="post" action="/dashboard/discover/run">
          <input type="hidden" name="channelType" value="${html(channelType)}">
          <textarea name="bvids" placeholder="每行一个BV号或B站视频链接" rows="5" style="width:100%;font:inherit;padding:8px;border:1px solid #cfc1ad;border-radius:8px"></textarea>
          <button type="submit" style="margin-top:10px">加入并预检</button>
        </form>
      </section>`
    }

    // --- Preflight results table (仅显示预检阶段的素材，已处理/已发布的不在此展示) ---
    let preflightTable = ''
    const discoverItems = results.filter(r => {
      const s = r.lifecycleStatus || r.verdict || ''
      return s.startsWith('PREFLIGHT') || s === 'METADATA_INCOMPLETE'
    })
    const preflightPassedItems = discoverItems.filter(r => r.verdict === 'PASSED' || r.lifecycleStatus === 'PREFLIGHT_PASSED')
    if (discoverItems.length > 0) {
      const pRows = discoverItems.map(r => {
        const passed = r.verdict === 'PASSED' || r.lifecycleStatus === 'PREFLIGHT_PASSED'
        return `<tr>
          <td><input type="checkbox" name="tids" value="${html(r.tutorialId || r._id)}" ${passed ? 'checked' : ''}></td>
          <td><a target="_blank" href="${html(r.sourceUrl || '#')}">${html(r.sourceTitle || r.sourceId || '')}</a></td>
          <td><small>${html(r.sourceId || '')}</small></td>
          <td>${badge(r.verdict || r.lifecycleStatus)}</td>
          <td>${r.score != null ? `<span class="score-chip">${r.score}</span>` : '—'}</td>
        </tr>`
      }).join('')
      preflightTable = `
      <section>
        <h2>发现结果 (${discoverItems.length})</h2>
        <form method="post" action="/dashboard/discover/push-to-processing" id="preflight-form">
          <table><thead><tr><th style="width:40px">选</th><th>标题</th><th>ID</th><th>预检</th><th>评分</th></tr></thead>
          <tbody>${pRows}</tbody></table>
          <div class="action-bar">
            <button type="button" class="btn-secondary" onclick="document.querySelectorAll('#preflight-form input[type=checkbox]').forEach(c=>c.checked=true)">全选预检通过的</button>
            <button type="submit" class="btn-primary">送入待处理 →</button>
          </div>
        </form>
      </section>`
    } else {
      preflightTable = '<section><p style="color:#806f61;text-align:center;padding:20px">暂无新发现的素材。请通过上方榜单发现、UP主关注或指定素材来发现新的做饭教程。</p></section>'
    }

    discoverContent = channelBar + subTabs + note + rankingForm + upsForm + directForm + preflightTable
  }

  // ═══════════════════════════════════════════════════════
  // SOP Tab 2: 待处理
  // ═══════════════════════════════════════════════════════
  let processingContent = ''
  if (activeSopTab === 'processing') {
    const processingStatuses = ['PREFLIGHT_PASSED', 'PROCESSING', 'QUEUED', 'DOWNLOADING', 'TRANSCRIBING', 'EXTRACTING', 'FRAMES_EXTRACTED', 'NOT_QUEUED', 'READY_TO_QUEUE', 'PROCESSING_FAILED']
    const filtered = results.filter(r => processingStatuses.includes(r.lifecycleStatus))
    const procRows = filtered.map(r => {
      const isReady = r.lifecycleStatus === 'PREFLIGHT_PASSED' || r.processingStatus === 'READY_TO_QUEUE' || r.processingStatus === 'NOT_QUEUED'
      const queueable = r.lifecycleStatus === 'PREFLIGHT_PASSED'
      const progressPct = ['DOWNLOADING','TRANSCRIBING','EXTRACTING'].includes(r.lifecycleStatus) || r.processingStatus === 'QUEUED'
      const progressHtml = progressPct
        ? `<div class="mini-progress"><div class="mini-progress-fill" style="width:${r.lifecycleStatus === 'DOWNLOADING' ? '25%' : r.lifecycleStatus === 'TRANSCRIBING' ? '50%' : r.lifecycleStatus === 'EXTRACTING' ? '75%' : '10%'}"></div></div><small style="color:#806f61">${cnStatus(r.lifecycleStatus)}</small>`
        : ''
      return `<tr>
        <td>${queueable ? `<input type="checkbox" name="tids" value="${html(r.tutorialId)}">` : '<span style="color:#bbbbbb;font-size:12px">—</span>'}</td>
        <td><a href="/dashboard/tutorials/${encodeURIComponent(r.tutorialId)}">${html(r.sourceTitle || r.sourceId)}</a></td>
        <td>${html(r.channelType)}</td>
        <td>${cnOwner(r.ownerType || '')}</td>
        <td>${badge(r.lifecycleStatus)}</td>
        <td>${progressHtml || (r.lifecycleStatus === 'PREFLIGHT_PASSED' ? '<span class="badge badge-sm ready-to-queue">待入队</span>' : badge(r.processingStatus || r.lifecycleStatus))}</td>
      </tr>`
    }).join('')
    processingContent = `
      <section>
        <h2>待处理素材 (${filtered.length})</h2>
        <form method="post" action="/dashboard/discover/start-processing" id="processing-form">
          <table><thead><tr><th style="width:40px">选</th><th>标题</th><th>渠道</th><th>归属</th><th>状态</th><th>进度</th></tr></thead>
          <tbody>${procRows || '<tr><td colspan="6">暂无待处理的素材。</td></tr>'}</tbody></table>
          <div class="action-bar">
            <button type="button" class="btn-secondary" onclick="var qs=document.querySelectorAll('#processing-form input[type=checkbox]');for(var c of qs)c.checked=true">全选待入队的</button>
            <button type="submit" class="btn-primary">开始处理 →</button>
          </div>
        </form>
      </section>`
  }

  // ═══════════════════════════════════════════════════════
  // SOP Tab 3: 待发布
  // ═══════════════════════════════════════════════════════
  let publishContent = ''
  if (activeSopTab === 'publish') {
    const publishStatuses = ['FRAMES_REVIEW', 'READY_TO_EXPORT', 'SYSTEM_REVIEW_REQUIRED', 'OWNER_REVIEW_REQUIRED', 'OWNER_APPROVED']
    const filtered = results.filter(r => publishStatuses.includes(r.lifecycleStatus))
    const pubRows = filtered.map(r => {
      const isFramesReview = r.lifecycleStatus === 'FRAMES_REVIEW'
      const isSystemReview = r.lifecycleStatus === 'SYSTEM_REVIEW_REQUIRED'
      const isReadyExport = r.lifecycleStatus === 'READY_TO_EXPORT'
      const selectable = isFramesReview || isSystemReview
      return `<tr>
        <td>${selectable ? `<input type="checkbox" name="tids" value="${html(r.tutorialId)}">` : '<span style="color:#bbbbbb;font-size:12px">—</span>'}</td>
        <td><a href="/dashboard/tutorials/${encodeURIComponent(r.tutorialId)}">${html(r.sourceTitle || r.sourceId)}</a></td>
        <td>${html(r.channelType)}</td>
        <td>${cnOwner(r.ownerType || '')}</td>
        <td>${badge(r.lifecycleStatus)}</td>
        <td>${html(String(r.revisionCount || 0))}</td>
      </tr>`
    }).join('')

    // Build contextual action bar
    let actionBar = `<div class="action-bar"><span style="color:#806f61;font-size:13px">选择素材后，可用操作将出现在此处</span></div>`
    const hasFramesReviewSystem = filtered.some(r => r.lifecycleStatus === 'FRAMES_REVIEW' && r.ownerType === 'SYSTEM')
    const hasSystemReview = filtered.some(r => r.lifecycleStatus === 'SYSTEM_REVIEW_REQUIRED')
    const hasReadyExport = filtered.some(r => r.lifecycleStatus === 'READY_TO_EXPORT')

    const actionButtons = []
    if (hasFramesReviewSystem) actionButtons.push(`<button type="button" class="btn-primary" onclick="goToFrames()">去挑帧</button>`)
    if (hasSystemReview) actionButtons.push(`<button type="submit" formaction="/dashboard/discover/publish-selected" class="btn-green">系统通过发布</button>`)
    if (hasSystemReview) actionButtons.push(`<button type="submit" formaction="/dashboard/discover/reject-selected" class="btn-reject">拒绝</button>`)
    if (hasReadyExport && !hasFramesReviewSystem && !hasSystemReview) actionButtons.push(`<span style="color:#b87825;font-size:13px">⏳ 等待导出...</span>`)

    actionBar = `
      <div class="action-bar">
        ${actionButtons.join('')}
        <script>
          function goToFrames() {
            var checked = document.querySelectorAll('#publish-form input[type=checkbox]:checked');
            if (checked.length === 0) { alert('请先选择素材'); return; }
            var tid = checked[0].value;
            location.href = '/dashboard/tutorials/' + encodeURIComponent(tid) + '/frames';
          }
        </script>
      </div>`

    publishContent = `
      <section>
        <h2>待发布素材 (${filtered.length})</h2>
        <form method="post" action="/dashboard/discover/publish-selected" id="publish-form">
          <table><thead><tr><th style="width:40px">选</th><th>标题</th><th>渠道</th><th>归属</th><th>状态</th><th>版本数</th></tr></thead>
          <tbody>${pubRows || '<tr><td colspan="6">暂无待发布的素材。</td></tr>'}</tbody></table>
          ${actionBar}
        </form>
      </section>`
  }

  // ── Render full page ──
  const pageTitle = '素材工作台'
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} · 庖丁解牛</title><style>
  :root{--ink:#342a24;--paper:#fffdf8;--line:#eadcc8;--coral:#d9694d;--green:#618c55;--amber:#b87825;--cream:#f8f1e4}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;background:var(--cream);color:var(--ink)}main{max-width:1160px;margin:auto;padding:28px 20px 64px}a{color:#bd573f;text-decoration:none}
  .hero{padding:20px 26px;border:1px solid var(--line);background:linear-gradient(135deg,#fffdf6,#fff5e7);border-radius:16px;margin-bottom:18px}
  .hero h1{margin:5px 0 3px;font-size:26px;letter-spacing:.03em}.hero .sub{color:#806f61;margin:0;font-size:14px}
  .sop-tabs{display:flex;gap:0;margin:16px 0 0}.sop-tab{flex:1;text-align:center;padding:13px 0;border:1px solid var(--line);border-bottom:none;background:#ede0cf;color:var(--ink);font-weight:650;font-size:15px;border-radius:12px 12px 0 0;text-decoration:none;transition:all .18s}
  .sop-tab.active{background:var(--paper);color:var(--coral);box-shadow:0 -3px 12px #765b4318}.sop-tab:hover{color:var(--coral)}
  .sub-tabs{display:flex;gap:4px;margin:12px 0 0;align-items:center}.sub-tab{padding:7px 16px;border:1px solid var(--line);border-radius:8px;text-decoration:none;color:#5c4b3f;background:#ede0cf;font-size:13px;font-weight:600}.sub-tab.active{background:var(--paper);color:var(--coral);border-color:var(--coral);font-weight:700}
  .channel-bar{display:flex;align-items:center;gap:12px;margin:10px 0;font-size:14px;font-weight:650}
  .channel-bar select{height:36px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;font:inherit;background:var(--paper)}
  section{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px;margin:12px 0;overflow:auto;box-shadow:0 4px 18px #765b430c}
  h2{font-size:16px;margin:0 0 10px;color:var(--ink)}
  table{width:100%;border-collapse:collapse;min-width:700px}
  th,td{padding:10px 8px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:middle}
  th{color:#806f61;font-weight:600;background:#fff8ec;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .badge{font-size:11px;border-radius:999px;padding:3px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap;display:inline-block}
  .badge.preflight_passed,.badge.passed,.badge.system,.badge.published{background:#e4f1df;color:#417138}
  .badge.preflight_rejected,.badge.rejected{background:#f9dfd8;color:#a8432f}
  .badge.processing,.badge.queued,.badge.downloading,.badge.transcribing,.badge.extracting,.badge.frames_review,.badge.frames_reviewed,.badge.system_review_required,.badge.owner_review_required,.badge.owner_approved,.badge.manual_review_required,.badge.metadata_incomplete{background:#fff0d4;color:#9a661a}
  .badge.read_to_export{background:#e8e0f0;color:#5c3d8a}
  .badge.ready_to_queue{background:#e4f1df;color:#417138;font-size:10px;padding:2px 7px}
  .badge-sm{padding:2px 7px;font-size:10px}
  .score-chip{display:inline-block;background:var(--coral);color:#fff;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:650}
  .msg{background:#e4f1df;color:#417138;border:1px solid #bcd9b0;padding:10px 12px;border-radius:9px;margin-bottom:12px;font-size:14px}
  button{font:inherit;cursor:pointer;border:0;border-radius:9px;padding:10px 18px;font-weight:650;transition:all .15s;font-size:14px}
  button:hover{opacity:0.9;transform:translateY(-1px)}
  button:active{transform:translateY(1px)}
  .btn-primary{background:var(--coral);color:#fff;box-shadow:0 4px 12px #d9694d44}
  .btn-secondary{background:var(--cream);color:var(--ink);border:1px solid #cfc1ad}
  .btn-green{background:var(--green);color:#fff;box-shadow:0 4px 12px #618c5544}
  .btn-reject{background:#ad4d39;color:#fff;box-shadow:0 4px 12px #ad4d3944}
  .btn-sm{padding:6px 12px;font-size:12px;border-radius:7px}
  .action-bar{display:flex;gap:10px;align-items:center;margin-top:14px;padding:12px 16px;background:#fff8ec;border-radius:10px;border:1px dashed var(--line);flex-wrap:wrap}
  input,textarea,select{font:inherit}
  .inline-form{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .inline-form input,.inline-form select{height:38px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;background:var(--paper)}
  input[type=checkbox]{width:18px;height:18px;cursor:pointer;accent-color:var(--coral)}
  .mini-progress{width:70px;height:6px;background:#eee3d2;border-radius:999px;overflow:hidden;margin-bottom:3px}
  .mini-progress-fill{height:100%;background:var(--amber);border-radius:999px;transition:width .6s ease}
  .back-link{display:inline-block;margin-bottom:10px;font-size:13px}
  @media(max-width:700px){main{padding:14px 10px}.sop-tab{font-size:13px;padding:10px 0}}</style>
  <main><a href="/dashboard" class="back-link">← 返回后台</a>
  <div class="hero"><h1>素材工作台</h1><p class="sub">做饭教程的全生命周期管理：发现 → 处理 → 审核发布</p></div>
  ${sopTabs}
  ${discoverContent}${processingContent}${publishContent}
  </main></html>`
}

function dashboardFramePage(detail, urlMap) {
  const t = detail.tutorial
  const draft = detail.draft || {}
  const steps = draft.steps || []
  const blocks = steps.map((s) => {
    const cands = (s.candidates || []).map((c, i) => {
      const url = urlMap[c.cloudFileId] || ''
      const id = `s${s.stepIndex}`
      const val = `${c.frameType}:${c.slot}`
      return `<label style="display:inline-block;margin:6px;text-align:center;cursor:pointer"><input type="radio" name="${id}" value="${html(val)}" ${i === 0 ? 'checked' : ''}><br><img src="${html(url)}" alt="${html(c.frameType)}" style="width:150px;height:auto;border:2px solid #eadfce;border-radius:8px"><br><small>${html(c.frameType)}</small></label>`
    }).join('')
    return `<section style="background:#fffdf8;border:1px solid #eadfce;border-radius:14px;padding:16px;margin:14px 0"><h3 style="margin:0 0 4px">步骤 ${s.stepIndex + 1}：${html(s.name || '')}</h3><p style="color:#806f61;margin:0 0 8px">${html(s.description || '')}</p><div>${cands || '<em>无候选帧</em>'}</div></section>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>挑帧 · 庖丁解牛</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026}main{max-width:900px;margin:auto}a{color:#c9573b}button{background:#618c55;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:inherit;cursor:pointer;position:sticky;bottom:20px}</style><main><p><a href="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}">← 返回教程详情</a></p><h1>为「${html(draft.recipeName || t.sourceTitle || t.sourceId)}」挑代表帧</h1><p>每步选一张最能展示动作的帧，提交后自动导出并进入系统审核。</p><form method="post" action="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}/frames">${blocks}<button type="submit">确认挑帧并导出</button></form></main></html>`
}

function dashboardDictionaryPage(items, dishes = [], activeTab = 'dishes') {
  const tabBar = `
    <div class="tabs" style="display:flex;gap:4px;margin:18px 0">
      <a href="?tab=dishes" class="tab ${activeTab === 'dishes' ? 'active' : ''}" style="padding:8px 18px;border:1px solid #eadcc8;border-radius:10px 10px 0 0;text-decoration:none;color:#342a24;background:${activeTab==='dishes'?'#fffdf8':'#f0e6d7'};font-size:14px;${activeTab==='dishes'?'font-weight:700;color:#d9694d':''}">菜品管理</a>
    </div>`

  // Count tutorials per dish
  const dishTutorialCount = {}
  if (items.length > 0) {
    for (const item of items) {
      // items from listDishDictionary may or may not have tutorialCount
    }
  }

  const dishRows = dishes.map((d) => {
    const aliases = (d.aliases || []).join(', ')
    const sigs = (d.ingredientSignature || []).join(', ')
    return `<tr>
      <td><strong>${html(d.canonicalName || '')}</strong></td>
      <td><small>${html(aliases || '—')}</small></td>
      <td><small>${html(sigs || '—')}</small></td>
      <td>${html(d.category || '—')}</td>
      <td>${html(String(d.tutorialCount || '—'))}</td>
      <td>
        <form method="post" action="/dashboard/dictionary/dish/${encodeURIComponent(d._id)}/edit" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
          <input name="aliases" placeholder="别名（逗号分隔）" value="${html(aliases)}" style="height:30px;border:1px solid #cfc1ad;border-radius:6px;padding:0 6px;font-size:12px;width:150px">
          <input name="category" placeholder="分类" value="${html(d.category || '')}" style="height:30px;border:1px solid #cfc1ad;border-radius:6px;padding:0 6px;font-size:12px;width:80px">
          <button style="background:#618c55;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px">保存</button>
        </form>
      </td>
    </tr>`
  }).join('')

  const dishContent = `
    <section style="background:#fffdf8;border:1px solid #eadcc8;border-radius:14px;padding:20px;margin:0 0 18px;overflow:auto">
      <h2 style="font-size:17px;margin:0 0 12px">菜品字典 (${dishes.length}条)</h2>
      <p style="color:#806f61;line-height:1.6;margin:0 0 14px">管理标准菜名及其别名、食材签名。菜品在服务器启动时自动从 recipe-icon 目录导入。编辑别名后，模糊匹配会将其纳入候选。</p>
      <div style="margin-bottom:14px">
        <form method="post" action="/dashboard/dictionary/dish/add" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input name="canonicalName" placeholder="新菜名（必填）" required style="height:34px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;width:160px">
          <input name="aliases" placeholder="别名（逗号分隔）" style="height:34px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;width:200px">
          <input name="ingredientSignature" placeholder="食材签名（逗号分隔）" style="height:34px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;width:200px">
          <input name="category" placeholder="分类" style="height:34px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;width:100px">
          <button style="background:#d9694d;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer">新增菜品</button>
        </form>
      </div>
      <table style="width:100%;border-collapse:collapse"><thead><tr><th>标准菜名</th><th>别名</th><th>食材签名</th><th>分类</th><th>教程数</th><th>操作</th></tr></thead><tbody>${dishRows || '<tr><td colspan="6">暂无菜品字典项</td></tr>'}</tbody></table>
    </section>`

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>菜品字典 · 庖丁解牛</title><style>
  :root{--ink:#342a24;--paper:#fffdf8;--line:#eadcc8;--coral:#d9694d;--green:#618c55;--amber:#b87825}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;background:#f8f1e4;color:var(--ink)}main{max-width:1100px;margin:auto;padding:32px 22px 64px}a{color:#bd573f}h1{margin-bottom:4px}section{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 18px;overflow:auto}h2{font-size:17px;margin:0 0 12px}table{width:100%;border-collapse:collapse;min-width:600px}th,td{padding:10px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:middle}th{color:#806f61;background:#fff8ec}.badge{font-size:11px;border-radius:999px;padding:4px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap}.badge.rejected{background:#f9dfd8;color:#a8432f}button{font:inherit;cursor:pointer}button:hover{opacity:0.9}input{font:inherit}</style>
  <main><p><a href="/dashboard">← 返回后台</a></p><h1>菜品字典</h1>
  ${tabBar}
  ${dishContent}
  </main></html>`
}


function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 64 * 1024) reject(new Error('请求体超过 64KB'))
    })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch (_) { reject(new ValidationError(['请求体不是合法 JSON'])) }
    })
    req.on('error', reject)
  })
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) reject(new Error('请求体超过 16KB')) })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, { ok: true, service: 'paoding-jieniu' })
    // 本地假云媒体服务（仅在 local-cloud 模式存在 localStorageRoot 时可用）。
    const localMediaMatch = req.method === 'GET' && req.url.match(/^\/__localmedia\/(.+)$/)
    if (localMediaMatch && cloud.localStorageRoot) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const rel = decodeURIComponent(localMediaMatch[1])
      const target = path.resolve(cloud.localStorageRoot, rel)
      if (!target.startsWith(`${path.resolve(cloud.localStorageRoot)}${path.sep}`)) { res.writeHead(403); return res.end('forbidden') }
      try { const buf = fs.readFileSync(target); res.writeHead(200, { 'content-type': rel.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }); return res.end(buf) } catch (_) { res.writeHead(404); return res.end('not found') }
    }
    if (req.method === 'GET' && req.url === '/dashboard/login') return res.end(loginPage(new URL(req.url, 'http://localhost').searchParams.get('error')))
    if (req.method === 'POST' && req.url === '/dashboard/login') {
      const form = await readForm(req)
      const username = String(form.username || ''); const password = String(form.password || '')
      const valid = dashboardUser && dashboardPassword && username.length === dashboardUser.length && password.length === dashboardPassword.length && crypto.timingSafeEqual(Buffer.from(username), Buffer.from(dashboardUser)) && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(dashboardPassword))
      if (!valid) { res.writeHead(303, { location: '/dashboard/login?error=invalid' }); return res.end() }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
      res.writeHead(303, { location: '/dashboard', 'set-cookie': `paoding_session=${createDashboardSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}` }); return res.end()
    }
    if (req.method === 'POST' && req.url === '/dashboard/logout') { res.writeHead(303, { location: '/dashboard/login', 'set-cookie': 'paoding_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' }); return res.end() }
    if (req.method === 'GET' && req.url === '/dashboard' || (req.method === 'GET' && req.url.startsWith('/dashboard?'))) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const url = new URL(req.url, 'http://localhost')
      const filter = {
        channelType: url.searchParams.get('channelType') || '',
        status: url.searchParams.get('status') || '',
        ownerType: url.searchParams.get('ownerType') || '',
      }
      let rows = await tutorials.list(200)
      if (filter.channelType) rows = rows.filter(t => t.channelType === filter.channelType)
      if (filter.status) rows = rows.filter(t => t.lifecycleStatus === filter.status)
      if (filter.ownerType) rows = rows.filter(t => t.ownerType === filter.ownerType)
      return res.end(dashboardPage(rows, filter))
    }
    const dashboardMatch = req.method === 'GET' && req.url.match(/^\/dashboard\/packages\/([^/?]+)$/)
    if (dashboardMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const detail = await publisher.getDashboardDetail(decodeURIComponent(dashboardMatch[1]))
      if (!detail) { res.writeHead(404); return res.end('Not found') }
      return res.end(dashboardDetailPage(detail))
    }
    const dashboardTutorialMatch = req.method === 'GET' && req.url.match(/^\/dashboard\/tutorials\/([^/?]+)$/)
    if (dashboardTutorialMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const detail = await tutorials.get(decodeURIComponent(dashboardTutorialMatch[1]))
      if (!detail) { res.writeHead(404); return res.end('Not found') }
      return res.end(dashboardTutorialPage(detail))
    }
    const dashboardTutorialReviewMatch = req.method === 'POST' && req.url.match(/^\/dashboard\/tutorials\/([^/?]+)\/review$/)
    if (dashboardTutorialReviewMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const tutorialId = decodeURIComponent(dashboardTutorialReviewMatch[1])
      const form = await readForm(req)
      try {
        await tutorials.review(tutorialId, { action: form.action, versionId: form.versionId, reason: form.reason }, dashboardUser || 'content-admin')
      } catch (error) { console.error('[paoding-jieniu] dashboard review failed', error.message) }
      res.writeHead(303, { location: `/dashboard/tutorials/${encodeURIComponent(tutorialId)}` }); return res.end()
    }
    if (req.method === 'GET' && req.url === '/dashboard/dictionary' || (req.method === 'GET' && req.url.startsWith('/dashboard/dictionary?'))) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const url = new URL(req.url, 'http://localhost')
      const tab = url.searchParams.get('tab') || 'dishes'
      const [queueItems, dishes] = await Promise.all([
        publisher.listDictionaryQueue('PENDING'),
        tutorials.listDishDictionary(200),
      ])
      return res.end(dashboardDictionaryPage(queueItems, dishes, tab))
    }
    const dashboardDictResolveMatch = req.method === 'POST' && req.url.match(/^\/dashboard\/dictionary\/([^/?]+)\/resolve$/)
    if (dashboardDictResolveMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      try {
        await publisher.resolveDictionaryQueue(decodeURIComponent(dashboardDictResolveMatch[1]), {
          action: form.mode || 'create_new', canonicalName: form.canonicalName, category: form.category, dictionaryId: form.dictionaryId, reviewer: dashboardUser || 'content-admin',
        })
      } catch (error) { console.error('[paoding-jieniu] dashboard dict resolve failed', error.message) }
      res.writeHead(303, { location: '/dashboard/dictionary' }); return res.end()
    }
    // 新增菜品到 dish_dictionary
    if (req.method === 'POST' && req.url === '/dashboard/dictionary/dish/add') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      try {
        const canonicalName = (form.canonicalName || '').trim()
        if (!canonicalName) throw new Error('菜名必填')
        await tutorials.upsertDishDictionary({ canonicalName }, {
          canonicalName,
          aliases: String(form.aliases || '').split(',').map(s => s.trim()).filter(Boolean),
          ingredientSignature: String(form.ingredientSignature || '').split(',').map(s => s.trim()).filter(Boolean),
          category: form.category || '',
        })
      } catch (error) { console.error('[paoding-jieniu] dish add failed', error.message) }
      res.writeHead(303, { location: '/dashboard/dictionary?tab=dishes' }); return res.end()
    }
    // 编辑菜品字典项
    const dashboardDishEditMatch = req.method === 'POST' && req.url.match(/^\/dashboard\/dictionary\/dish\/([^/?]+)\/edit$/)
    if (dashboardDishEditMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      try {
        await tutorials.upsertDishDictionary({ _id: decodeURIComponent(dashboardDishEditMatch[1]) }, {
          aliases: String(form.aliases || '').split(',').map(s => s.trim()).filter(Boolean),
          category: form.category || '',
        })
      } catch (error) { console.error('[paoding-jieniu] dish edit failed', error.message) }
      res.writeHead(303, { location: '/dashboard/dictionary?tab=dishes' }); return res.end()
    }
    if (req.method === 'GET' && req.url.match(/^\/dashboard\/discover/)) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const url = new URL(req.url, 'http://localhost')
      const channelType = url.searchParams.get('channel') || 'bilibili'
      const activeSopTab = url.searchParams.get('sop') || 'discover'
      const activeSubTab = url.searchParams.get('sub') || 'ranking'
      const msg = url.searchParams.get('msg') || ''

      // 获取UP主列表
      let upsList = []
      try {
        const { listUpsSubscriptions } = require('./supervisor')
        upsList = await listUpsSubscriptions(port)
      } catch (_) {}

      // 获取所有教程，由页面函数自行过滤
      let allTutorials = []
      try {
        allTutorials = await tutorials.list(200)
      } catch (_) {}

      return res.end(dashboardDiscoverPage(msg, channelType, activeSopTab, activeSubTab, allTutorials, upsList))
    }
    // —— 渲染素材工作台页面的辅助函数（直接渲染，不走重定向） ——
    async function renderWorkbench(res, msg, sop, sub) {
      const channelType = 'bilibili'
      const activeSopTabVal = sop || 'discover'
      const activeSubTabVal = sub || 'ranking'
      let upsList = []
      try { upsList = await listUpsSubscriptions(port) } catch (_) {}
      let allTutorials = []
      try { allTutorials = await tutorials.list(200) } catch (_) {}
      return res.end(dashboardDiscoverPage(msg, channelType, activeSopTabVal, activeSubTabVal, allTutorials, upsList))
    }
    if (req.method === 'POST' && req.url === '/dashboard/discover/run') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const { runDiscoveryOnce } = require('./supervisor')
      const bvids = String(form.bvids || '').split(/\s+/).filter(Boolean)
      runDiscoveryOnce(port, { source: form.source || 'food_3day', limit: form.limit || '30', bvids })
        .catch((error) => console.error('[paoding-jieniu] discover run failed', error.message))
      return renderWorkbench(res, '发现任务已触发，稍后刷新查看候选素材', 'discover', 'ranking')
    }
    if (req.method === 'POST' && req.url === '/dashboard/discover/enqueue-batch') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const tids = Array.isArray(form.tids) ? form.tids : (form.tids ? [form.tids] : [])
      for (const tid of tids) {
        try { await tutorials.enqueue(tid, dashboardUser || 'content-admin') } catch (e) { console.error('[paoding-jieniu] batch enqueue failed for', tid, e.message) }
      }
      res.writeHead(303, { location: `/dashboard/discover?msg=${encodeURIComponent(`已入队${tids.length}个教程`)}` }); return res.end()
    }
    // POST /dashboard/discover/push-to-processing — 批量将预检通过的素材送入待处理
    if (req.method === 'POST' && req.url === '/dashboard/discover/push-to-processing') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const tids = Array.isArray(form.tids) ? form.tids : (form.tids ? [form.tids] : [])
      let pushed = 0, skipped = 0
      for (const tid of tids) {
        try {
          const t = await tutorials.get(tid)
          if (t && t.tutorial && t.tutorial.lifecycleStatus === 'PREFLIGHT_PASSED') {
            await tutorials.enqueue(tid, dashboardUser || 'content-admin'); pushed++
          } else { skipped++ }
        } catch (e) { skipped++ }
      }
      const msg = pushed > 0
        ? `已将 ${pushed} 个素材送入待处理` + (skipped > 0 ? `，${skipped} 个未通过预检被跳过` : '')
        : `${skipped} 个素材未通过预检，无法送入待处理`
      return renderWorkbench(res, msg, 'processing', '')
    }
    // POST /dashboard/discover/start-processing — 批量入队开始处理
    if (req.method === 'POST' && req.url === '/dashboard/discover/start-processing') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const tids = Array.isArray(form.tids) ? form.tids : (form.tids ? [form.tids] : [])
      let count = 0
      for (const tid of tids) {
        try { await tutorials.enqueue(tid, dashboardUser || 'content-admin'); count++ } catch (e) {}
      }
      return renderWorkbench(res, `已开始处理 ${count} 个素材`, 'processing', '')
    }
    // POST /dashboard/discover/publish-selected — 批量系统通过发布
    if (req.method === 'POST' && req.url === '/dashboard/discover/publish-selected') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const tids = Array.isArray(form.tids) ? form.tids : (form.tids ? [form.tids] : [])
      let count = 0
      for (const tid of tids) {
        try { await tutorials.review(tid, { action: 'SYSTEM_APPROVE', versionId: null }, dashboardUser || 'content-admin'); count++ } catch (e) {}
      }
      return renderWorkbench(res, `已发布 ${count} 个素材`, 'publish', '')
    }
    // POST /dashboard/discover/reject-selected — 批量拒绝
    if (req.method === 'POST' && req.url === '/dashboard/discover/reject-selected') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const tids = Array.isArray(form.tids) ? form.tids : (form.tids ? [form.tids] : [])
      let count = 0
      for (const tid of tids) {
        try { await tutorials.review(tid, { action: 'REJECT', versionId: null, reason: form.reason || '管理员拒绝' }, dashboardUser || 'content-admin'); count++ } catch (e) {}
      }
      return renderWorkbench(res, `已拒绝 ${count} 个素材`, 'publish', '')
    }
    // UP主管理 API
    if (req.method === 'POST' && req.url === '/dashboard/ups/crawl') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const { runUpsCrawl } = require('./supervisor')
      runUpsCrawl(port).catch(e => console.error('[paoding-jieniu] ups crawl failed', e.message))
      return renderWorkbench(res, 'UP主视频拉取已触发', 'discover', 'up_subscription')
    }
    if (req.method === 'POST' && req.url === '/dashboard/ups/add') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const { addUpsSubscription } = require('./supervisor')
      addUpsSubscription(port, form.mid).catch(e => console.error('[paoding-jieniu] ups add failed', e.message))
      return renderWorkbench(res, '已添加UP主', 'discover', 'up_subscription')
    }
    if (req.method === 'POST' && req.url === '/dashboard/ups/remove') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const { removeUpsSubscription } = require('./supervisor')
      removeUpsSubscription(port, form.mid).catch(e => console.error('[paoding-jieniu] ups remove failed', e.message))
      return renderWorkbench(res, '已取消关注', 'discover', 'up_subscription')
    }
    const dashboardEnqueueMatch = req.method === 'POST' && req.url.match(/^\/dashboard\/tutorials\/([^/?]+)\/enqueue$/)
    if (dashboardEnqueueMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const tutorialId = decodeURIComponent(dashboardEnqueueMatch[1])
      try { await tutorials.enqueue(tutorialId, dashboardUser || 'content-admin') } catch (error) { console.error('[paoding-jieniu] dashboard enqueue failed', error.message) }
      res.writeHead(303, { location: `/dashboard/tutorials/${encodeURIComponent(tutorialId)}` }); return res.end()
    }
    const dashboardFramesGetMatch = req.method === 'GET' && req.url.match(/^\/dashboard\/tutorials\/([^/?]+)\/frames$/)
    if (dashboardFramesGetMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const detail = await tutorials.getDraft(decodeURIComponent(dashboardFramesGetMatch[1]))
      if (!detail || !detail.tutorial) { res.writeHead(404); return res.end('Not found') }
      const fileIds = (detail.draft?.steps || []).flatMap((s) => (s.candidates || []).map((c) => c.cloudFileId))
      const urlMap = await resolveTempUrls(fileIds)
      return res.end(dashboardFramePage(detail, urlMap))
    }
    const dashboardFramesPostMatch = req.method === 'POST' && req.url.match(/^\/dashboard\/tutorials\/([^/?]+)\/frames$/)
    if (dashboardFramesPostMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const tutorialId = decodeURIComponent(dashboardFramesPostMatch[1])
      const form = await readForm(req)
      const selections = Object.entries(form)
        .filter(([key]) => /^s\d+$/.test(key))
        .map(([key, value]) => { const [frameType, slot] = String(value).split(':'); return { stepIndex: Number(key.slice(1)), frameType, slot: Number(slot) || 0 } })
      try { await tutorials.submitFrameSelection(tutorialId, selections, dashboardUser || 'content-admin') } catch (error) { console.error('[paoding-jieniu] dashboard frame-selection failed', error.message) }
      res.writeHead(303, { location: `/dashboard/tutorials/${encodeURIComponent(tutorialId)}` }); return res.end()
    }
    const dashboardPublishMatch = req.method === 'POST' && req.url.match(/^\/dashboard\/recipes\/([^/?]+)\/publish$/)
    if (dashboardPublishMatch) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      await publisher.publishRecipe(decodeURIComponent(dashboardPublishMatch[1]), dashboardUser || 'content-admin')
      res.writeHead(303, { location: '/dashboard' }); return res.end()
    }
    if (!isAuthorized(req)) return reply(res, 401, { code: 'UNAUTHORIZED', message: '缺少或无效的内部令牌' })
    const actor = req.headers['x-actor-id'] || 'content-service'
    // 新接口
    if (req.method === 'POST' && req.url === '/v1/tutorials/submit') {
      return reply(res, 201, { data: await tutorials.submitSource(await readJson(req), actor) })
    }
    // 向后兼容旧接口
    if (req.method === 'POST' && req.url === '/v1/tutorials/bilibili') {
      return reply(res, 201, { data: await tutorials.submitSource({ ...(await readJson(req)), channelType: 'bilibili' }, actor) })
    }
    const preflightMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/preflight$/)
    if (preflightMatch) return reply(res, 200, { data: await tutorials.preflight(decodeURIComponent(preflightMatch[1]), (await readJson(req)).metadata, actor) })
    const updateMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/updates$/)
    if (updateMatch) return reply(res, 202, { data: await tutorials.requestUpdate(decodeURIComponent(updateMatch[1]), await readJson(req), actor) })
    const enqueueMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/enqueue$/)
    if (enqueueMatch) return reply(res, 202, { data: await tutorials.enqueue(decodeURIComponent(enqueueMatch[1]), actor) })
    if (req.method === 'POST' && req.url === '/v1/processing-tasks/claim') { const body = await readJson(req); return reply(res, 200, { data: await tutorials.claimNext(body.workerId || actor, body.kind || 'PROCESS') }) }
    if (req.method === 'POST' && req.url === '/v1/frames') { const body = await readJson(req); return reply(res, 201, { data: await publisher.uploadFrame(body.data, body.mimeType) }) }
    const draftPostMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/draft$/)
    if (draftPostMatch) return reply(res, 201, { data: await tutorials.registerDraft(decodeURIComponent(draftPostMatch[1]), await readJson(req), actor) })
    const draftGetMatch = req.method === 'GET' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/draft$/)
    if (draftGetMatch) { const d = await tutorials.getDraft(decodeURIComponent(draftGetMatch[1])); return d ? reply(res, 200, { data: d }) : reply(res, 404, { code: 'NOT_FOUND', message: '未找到草稿' }) }
    const frameSelMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/frame-selection$/)
    if (frameSelMatch) return reply(res, 200, { data: await tutorials.submitFrameSelection(decodeURIComponent(frameSelMatch[1]), (await readJson(req)).selections, actor) })
    const taskStatusMatch = req.method === 'POST' && req.url.match(/^\/v1\/processing-tasks\/([^/?]+)\/status$/)
    if (taskStatusMatch) return reply(res, 200, { data: await tutorials.updateTask(decodeURIComponent(taskStatusMatch[1]), await readJson(req), actor) })
    const versionMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/versions$/)
    if (versionMatch) { const body = await readJson(req); return reply(res, 201, { data: await tutorials.registerVersion({ ...body, tutorialId: decodeURIComponent(versionMatch[1]) }, actor) }) }
    const reviewMatch = req.method === 'POST' && req.url.match(/^\/v1\/tutorials\/([^/?]+)\/review$/)
    if (reviewMatch) return reply(res, 200, { data: await tutorials.review(decodeURIComponent(reviewMatch[1]), await readJson(req), actor) })
    if (req.method === 'GET' && req.url.match(/^\/v1\/dishes\/match/)) {
      const url = new URL(req.url, 'http://localhost')
      const name = url.searchParams.get('name') || ''
      const ingredients = url.searchParams.get('ingredients') || ''
      const ingList = ingredients ? ingredients.split(',').map(s => ({ rawName: s.trim() })) : []
      return reply(res, 200, { data: await tutorials.matchDish(name, ingList) })
    }
    if (req.method === 'GET' && req.url === '/v1/tutorials') return reply(res, 200, { data: await tutorials.list() })
    const tutorialMatch = req.method === 'GET' && req.url.match(/^\/v1\/tutorials\/([^/?]+)$/)
    if (tutorialMatch) { const detail = await tutorials.get(decodeURIComponent(tutorialMatch[1])); return detail ? reply(res, 200, { data: detail }) : reply(res, 404, { code: 'NOT_FOUND', message: '未找到教程' }) }
    if (req.method === 'POST' && req.url === '/v1/packages') {
      const body = await readJson(req)
      if (typeof body.packagePath !== 'string') throw new ValidationError(['packagePath 必填，且必须是 INGEST_ROOT 内的相对路径'])
      publisher.publish(body.packagePath)
        .catch((error) => console.error('[paoding-jieniu] async publish failed', error))
      return reply(res, 202, { accepted: true, packagePath: body.packagePath, status: 'RECEIVED' })
    }
    const resolveMatch = req.method === 'POST' && req.url.match(/^\/v1\/review-queue\/([^/?]+)\/resolve$/)
    if (resolveMatch) {
      const body = await readJson(req)
      return reply(res, 200, { data: await publisher.resolveDictionaryQueue(decodeURIComponent(resolveMatch[1]), body) })
    }
    const publishMatch = req.method === 'POST' && req.url.match(/^\/v1\/recipes\/([^/?]+)\/publish$/)
    if (publishMatch) {
      const body = await readJson(req)
      return reply(res, 200, { data: await publisher.publishRecipe(decodeURIComponent(publishMatch[1]), body.reviewer || 'content-admin') })
    }
    const match = req.method === 'GET' && req.url.match(/^\/v1\/packages\/([^/?]+)$/)
    if (match) {
      const job = await publisher.getJob(decodeURIComponent(match[1]))
      return job ? reply(res, 200, { data: job }) : reply(res, 404, { code: 'NOT_FOUND', message: '未找到处理包' })
    }
    return reply(res, 404, { code: 'NOT_FOUND', message: '接口不存在' })
  } catch (error) {
    const status = error instanceof ValidationError ? 400 : 500
    return reply(res, status, { code: error.name || 'INTERNAL_ERROR', message: error.message })
  }
})

async function seedDishDictionaryFromIcons() {
  const fs = require('fs'), path = require('path')
  const iconDir = path.resolve(__dirname, '../../../resource/recipe-icon')
  if (!fs.existsSync(iconDir)) return
  const files = fs.readdirSync(iconDir).filter(f => f.endsWith('.png'))
  for (const file of files) {
    const dishName = file.replace('.png', '')
    await tutorials.upsertDishDictionary({ canonicalName: dishName }, { canonicalName: dishName, aliases: [], ingredientSignature: [], category: '待归类' })
  }
  console.warn(`[paoding-jieniu] seeded ${files.length} dishes from recipe icons`)
}

server.listen(port, host, () => {
  console.log(`[paoding-jieniu] listening on http://${host}:${port}; ingest root=${ingestRoot}`)
  seedDishDictionaryFromIcons().catch(() => {})
})

if (watch) {
  setInterval(() => publisher.scanReadyPackages().catch((error) => console.error('[paoding-jieniu] scan failed', error)), intervalMs)
  publisher.scanReadyPackages().catch((error) => console.error('[paoding-jieniu] initial scan failed', error))
}

// 单容器模式：Node 主进程内嵌并守护 Python worker + 发现调度。
if (process.env.EMBED_WORKER === 'true') {
  const { spawnWorker, startDiscoveryScheduler } = require('./supervisor')
  spawnWorker(port)
  startDiscoveryScheduler(port)
}

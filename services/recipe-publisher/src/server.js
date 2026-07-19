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

function badge(value) { return `<span class="badge ${html(value).toLowerCase()}">${html(value || '—')}</span>` }
function dashboardPage(rows, tutorialRows) {
  const table = rows.map((job) => `<tr><td>${html(job.ingestedAt || job.createdAt || '')}</td><td><a href="/dashboard/packages/${encodeURIComponent(job.packageId)}">${html(job.packageId)}</a></td><td>${html(job.status)}</td><td>${html(job.recipeName || '')}</td><td>${job.sourceUrl ? `<a href="${html(job.sourceUrl)}" target="_blank">${html(job.sourcePlatform || '')} · ${html(job.sourceContentId || '')}</a>` : ''}</td><td>${html(job.rightsStatus || '')}</td><td>${html(job.publishedAt || '未公开发布')}</td></tr>`).join('')
  const tutorialsTable = tutorialRows.map((item) => `<tr><td><a href="/dashboard/tutorials/${encodeURIComponent(item.tutorialId)}">${html(item.sourceTitle || item.bvid)}</a><br><small>${html(item.bvid)}</small></td><td>${badge(item.ownerType)}</td><td>${badge(item.lifecycleStatus)}</td><td>${badge(item.visibility)}</td><td>${html(item.currentVersionId || '尚无处理版本')}</td><td>${html(item.updatedAt || '')}</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>庖丁解牛 · 内容后台</title><style>
  :root{--ink:#342a24;--paper:#fffaf0;--line:#eadcc8;--coral:#d9694d;--green:#618c55;--amber:#b87825}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;background:#f8f1e4;color:var(--ink)}main{max-width:1240px;margin:auto;padding:32px 22px 64px}.hero{padding:24px 28px;border:1px solid var(--line);background:linear-gradient(135deg,#fffdf6,#fff5e7);border-radius:18px;margin-bottom:22px}.eyebrow{color:var(--coral);font-weight:700;letter-spacing:.12em;font-size:12px}.hero h1{margin:7px 0;font-size:30px}.sub{color:#806f61;line-height:1.6;margin:0}.tabs{display:flex;gap:18px;margin:20px 0;font-weight:700}.tabs a{color:var(--ink);text-decoration:none}.tabs a:first-child{color:var(--coral)}section{background:#fffdf8;border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0;overflow:auto}h2{font-size:18px;margin:0 0 5px}small{color:#8d7d6e}.badge{font-size:11px;border-radius:999px;padding:4px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap}.badge.published,.badge.system_approved,.badge.preflight_passed{background:#e4f1df;color:#417138}.badge.rejected,.badge.preflight_rejected{background:#f9dfd8;color:#a8432f}.badge.system_review_required,.badge.owner_review_required,.badge.waiting_review{background:#fff0d4;color:#9a661a}table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:12px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:top}th{color:#806f61;font-weight:600;background:#fff8ec}a{color:#bd573f} @media(max-width:700px){main{padding:16px}.hero{padding:18px}.hero h1{font-size:25px}}</style>
  <main><div class="hero"><div class="eyebrow">食光宝盒 · 内容控制台</div><h1>庖丁解牛</h1><p class="sub">B站做饭教程的发现、下载前预检、处理、双审核与版本发布。云端归档为权威，本地 manifest 删除不影响已入库记录。</p><form method="post" action="/dashboard/logout" style="margin-top:14px"><button style="border:0;background:none;padding:0;color:#8a6554;text-decoration:underline;cursor:pointer">退出登录</button></form></div><nav class="tabs"><a href="/dashboard/discover">发现</a><a href="#tutorials">教程库</a><a href="#packages">处理包</a><a href="/dashboard/dictionary">词典审核</a></nav>
  <section id="tutorials"><h2>教程库</h2><p class="sub">系统教程由后台审核；用户教程先由所有者自审，申请分享或公开后进入系统审核。</p><table><thead><tr><th>教程 / BVID</th><th>归属</th><th>状态</th><th>可见性</th><th>当前版本</th><th>最近更新</th></tr></thead><tbody>${tutorialsTable || '<tr><td colspan="6">暂无教程；可通过内部 API 提交 B站 BV 号。</td></tr>'}</tbody></table></section>
  <section id="packages"><h2>处理包与发布记录</h2><p class="sub">记录 manifest、素材来源、入库时间、授权与公开发布日期。</p><table><thead><tr><th>入库时间</th><th>处理包</th><th>状态</th><th>菜谱</th><th>对标素材</th><th>授权</th><th>公开发布日期</th></tr></thead><tbody>${table || '<tr><td colspan="7">暂无处理包</td></tr>'}</tbody></table></section></main></html>`
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
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>庖丁解牛 · 教程详情</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026;line-height:1.6}main{max-width:960px;margin:auto}pre{white-space:pre-wrap;word-break:break-word;background:#fff;padding:18px;border:1px solid #eadfce;border-radius:12px}a{color:#c9573b}h1{margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{padding:10px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:middle}th{color:#806f61;background:#fff8ec}.badge{font-size:11px;border-radius:999px;padding:4px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap}.badge.published,.badge.system_approved,.badge.owner_approved{background:#e4f1df;color:#417138}.badge.rejected{background:#f9dfd8;color:#a8432f}.badge.system_review_required,.badge.owner_review_required{background:#fff0d4;color:#9a661a}.warn{background:#fff0ec;color:#9e3e2e;border:1px solid #efc2b7;padding:8px 12px;border-radius:9px;font-size:13px}</style><main><p><a href="/dashboard">← 返回庖丁解牛后台</a></p><h1>${html(t.sourceTitle || t.bvid)}</h1><p>B站来源：<a target="_blank" href="${html(t.sourceUrl)}">${html(t.bvid)}</a> · ${badge(t.ownerType)} · ${badge(t.lifecycleStatus)} · 可见性 ${badge(t.visibility)}</p><p>来源授权：<strong>${html(t.sourceRightsStatus || 'unknown')}</strong>${t.sourceRightsStatus !== 'cleared' ? '<span class="warn" style="margin-left:8px">系统发布/分享要求来源授权为 cleared</span>' : ''}</p>${actionBar}
  <h2>版本与审核</h2><table><thead><tr><th>版本</th><th>审核状态</th><th>发布状态</th><th>申请可见性</th><th>变更说明</th><th>系统审核操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6">尚无处理版本</td></tr>'}</tbody></table>
  <h2>处理任务与审计历史</h2><pre>${html(JSON.stringify({ tasks: detail.tasks, events: detail.events }, null, 2))}</pre></main></html>`
}

function dashboardDiscoverPage(message = '') {
  const note = message ? `<div style="background:#e4f1df;color:#417138;border:1px solid #bcd9b0;padding:10px 12px;border-radius:9px;margin-bottom:14px">${html(message)}</div>` : ''
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>发现 · 庖丁解牛</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026}main{max-width:820px;margin:auto}a{color:#c9573b}section{background:#fffdf8;border:1px solid #eadfce;border-radius:14px;padding:20px;margin:16px 0}h2{font-size:17px;margin:0 0 10px}input,button{font:inherit}input{height:38px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px}button{background:#d9694d;color:#fff;border:0;border-radius:9px;padding:10px 16px;cursor:pointer}label{font-size:13px;color:#806f61;margin-right:6px}</style><main><p><a href="/dashboard">← 返回后台</a></p><h1>发现 B站做饭教程</h1><p>抓候选并做「仅元数据」预检（播放量不放行）；通过项进入教程库等待入队处理。</p>${note}
  <section><h2>按来源发现</h2><form method="post" action="/dashboard/discover/run"><label>来源</label><select name="source" style="height:38px;border:1px solid #cfc1ad;border-radius:8px;padding:0 8px"><option value="food_3day">美食三日榜</option><option value="historical">历史优质（关键词搜索）</option><option value="auto">两者合并</option></select> <label>数量</label><input name="limit" value="30" style="width:80px"> <button type="submit">开始发现</button></form></section>
  <section><h2>按 BV 号 / 链接手动加</h2><form method="post" action="/dashboard/discover/run"><input name="bvids" placeholder="BV号或链接，多个用空格分隔" style="width:70%"> <button type="submit">加入并预检</button></form></section></main></html>`
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
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>挑帧 · 庖丁解牛</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026}main{max-width:900px;margin:auto}a{color:#c9573b}button{background:#618c55;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:inherit;cursor:pointer;position:sticky;bottom:20px}</style><main><p><a href="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}">← 返回教程详情</a></p><h1>为「${html(draft.recipeName || t.sourceTitle || t.bvid)}」挑代表帧</h1><p>每步选一张最能展示动作的帧，提交后自动导出并进入系统审核。</p><form method="post" action="/dashboard/tutorials/${encodeURIComponent(t.tutorialId)}/frames">${blocks}<button type="submit">确认挑帧并导出</button></form></main></html>`
}

function dashboardDictionaryPage(items) {
  const rows = items.map((q) => `<tr><td>${badge(q.dictionaryKind)}</td><td>${html(q.rawName)}</td><td>${html(q.normalizedName || '')}</td><td>${q.blockingPublish ? '<span class="badge rejected">阻断发布</span>' : ''}</td><td>${html(String(q.occurrenceCount || 1))}</td><td>
    <form method="post" action="/dashboard/dictionary/${encodeURIComponent(q._id)}/resolve" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <input name="canonicalName" placeholder="新建标准名" value="${html(q.rawName)}" style="height:32px;border:1px solid #cfc1ad;border-radius:8px;padding:0 8px">
      <input name="category" placeholder="分类（可选）" style="height:32px;border:1px solid #cfc1ad;border-radius:8px;padding:0 8px">
      <button name="mode" value="create_new" style="background:#618c55;color:#fff;border:0;border-radius:8px;padding:7px 12px;cursor:pointer">建为标准名</button>
    </form></td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>词典审核 · 庖丁解牛</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:32px;background:#fff9ef;color:#3b3026}main{max-width:1040px;margin:auto}a{color:#c9573b}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:middle}th{color:#806f61;background:#fff8ec}.badge{font-size:11px;border-radius:999px;padding:4px 8px;background:#eee3d2;color:#5c4b3f}.badge.rejected{background:#f9dfd8;color:#a8432f}</style><main><p><a href="/dashboard">← 返回后台</a></p><h1>词典审核队列</h1><p>未匹配或低置信度的菜名/食材。建为标准名后，原始名会补进该主档别名，后续 manifest 自动命中。</p><table><thead><tr><th>类型</th><th>原始名</th><th>归一名</th><th>发布影响</th><th>出现次数</th><th>处理</th></tr></thead><tbody>${rows || '<tr><td colspan="6">暂无待审核词典项</td></tr>'}</tbody></table></main></html>`
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
    if (req.method === 'GET' && req.url === '/dashboard') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      return res.end(dashboardPage(await publisher.listJobs(), await tutorials.list()))
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
    if (req.method === 'GET' && req.url === '/dashboard/dictionary') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      return res.end(dashboardDictionaryPage(await publisher.listDictionaryQueue('PENDING')))
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
    if (req.method === 'GET' && req.url.match(/^\/dashboard\/discover(\?|$)/)) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const msg = new URL(req.url, 'http://localhost').searchParams.get('msg') || ''
      return res.end(dashboardDiscoverPage(msg))
    }
    if (req.method === 'POST' && req.url === '/dashboard/discover/run') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const { runDiscoveryOnce } = require('./supervisor')
      const bvids = String(form.bvids || '').split(/\s+/).filter(Boolean)
      runDiscoveryOnce(port, { source: form.source || 'food_3day', limit: form.limit || '30', bvids })
        .catch((error) => console.error('[paoding-jieniu] discover run failed', error.message))
      res.writeHead(303, { location: `/dashboard/discover?msg=${encodeURIComponent('发现任务已触发，稍后在教程库查看候选。')}` }); return res.end()
    }
    // UP主管理 API
    if (req.method === 'POST' && req.url === '/dashboard/ups/crawl') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const { runUpsCrawl } = require('./supervisor')
      runUpsCrawl(port).catch(e => console.error('[paoding-jieniu] ups crawl failed', e.message))
      res.writeHead(303, { location: '/dashboard/discover?msg=UP主视频拉取已触发' }); return res.end()
    }
    if (req.method === 'POST' && req.url === '/dashboard/ups/add') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const { addUpsSubscription } = require('./supervisor')
      addUpsSubscription(port, form.mid).catch(e => console.error('[paoding-jieniu] ups add failed', e.message))
      res.writeHead(303, { location: '/dashboard/discover?msg=已添加UP主' }); return res.end()
    }
    if (req.method === 'POST' && req.url === '/dashboard/ups/remove') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const { removeUpsSubscription } = require('./supervisor')
      removeUpsSubscription(port, form.mid).catch(e => console.error('[paoding-jieniu] ups remove failed', e.message))
      res.writeHead(303, { location: '/dashboard/discover?msg=已取消关注' }); return res.end()
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

server.listen(port, host, () => console.log(`[paoding-jieniu] listening on http://${host}:${port}; ingest root=${ingestRoot}`))

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

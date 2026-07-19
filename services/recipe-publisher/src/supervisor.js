'use strict'

// 单容器进程守护：Node 主进程 spawn 并守护 Python 引擎 worker 子进程，
// 并按需启动发现调度（定时 shell discovery_push）。同容器共享文件系统，
// worker 通过 http://127.0.0.1:PORT 调控制面。
//
// 由 EMBED_WORKER=true（容器默认）在 server.js listen 后启用；本地纯 UI 调试可关。

const { spawn } = require('child_process')
const path = require('path')

const WORKER_ROOT = path.resolve(__dirname, '..')
const PYTHON = process.env.PYTHON_BIN || 'python3'

function baseEnv(port) {
  return {
    ...process.env,
    PAODING_API_BASE: process.env.PAODING_API_BASE || `http://127.0.0.1:${port}`,
  }
}

/** 起 worker 子进程；退出后自动重启（带退避），除非父进程正在关闭。 */
function spawnWorker(port) {
  let stopping = false
  let backoff = 1000
  const start = () => {
    if (stopping) return
    const child = spawn(PYTHON, ['worker/paoding_worker.py'], { cwd: WORKER_ROOT, env: baseEnv(port), stdio: 'inherit' })
    child.on('exit', (code, signal) => {
      if (stopping) return
      console.warn(`[supervisor] worker 退出 code=${code} signal=${signal}，${backoff}ms 后重启`)
      setTimeout(start, backoff)
      backoff = Math.min(backoff * 2, 30000)
    })
    child.on('spawn', () => { backoff = 1000; console.log('[supervisor] worker 子进程已启动') })
    child.on('error', (err) => console.error('[supervisor] worker spawn 失败', err.message))
  }
  start()
  return () => { stopping = true }
}

/** 定时发现：按 DISCOVERY_INTERVAL_MS（>0 才开）shell discovery_push。 */
function startDiscoveryScheduler(port) {
  const interval = Number(process.env.DISCOVERY_INTERVAL_MS || 0)
  if (!interval || interval < 60000) { console.log('[supervisor] 定时发现未启用（DISCOVERY_INTERVAL_MS 未设或 < 60000）'); return () => {} }
  const source = process.env.DISCOVERY_SOURCE || 'food_3day'
  const limit = String(process.env.DISCOVERY_LIMIT || '30')
  const runDiscovery = () => {
    console.log(`[supervisor] 定时发现启动 source=${source} limit=${limit}`)
    const child = spawn(PYTHON, ['worker/discovery_push.py', '--source', source, '--limit', limit], { cwd: WORKER_ROOT, env: baseEnv(port), stdio: 'inherit' })
    child.on('error', (err) => console.error('[supervisor] discovery spawn 失败', err.message))
  }
  const timer = setInterval(runDiscovery, interval)
  console.log(`[supervisor] 定时发现已启用，每 ${interval}ms 一次`)
  return () => clearInterval(timer)
}

/** 手动触发一次发现（供 Dashboard 按钮调用）。resolve 退出码。 */
function runDiscoveryOnce(port, { source = 'food_3day', limit = '30', bvids = [] } = {}) {
  return new Promise((resolve) => {
    const args = bvids.length ? ['worker/discovery_push.py', ...bvids] : ['worker/discovery_push.py', '--source', source, '--limit', String(limit)]
    const child = spawn(PYTHON, args, { cwd: WORKER_ROOT, env: baseEnv(port), stdio: 'inherit' })
    child.on('exit', (code) => resolve(code || 0))
    child.on('error', (err) => { console.error('[supervisor] discovery 手动触发失败', err.message); resolve(1) })
  })
}

/** 拉取所有已关注UP主的新视频。 */
function runUpsCrawl(port) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['worker/discovery_push.py', '--source', 'ups', '--limit', '30'],
      { cwd: WORKER_ROOT, env: baseEnv(port), stdio: 'inherit' })
    child.on('exit', (code) => resolve(code || 0))
    child.on('error', (err) => { console.error('[supervisor] ups crawl failed', err.message); resolve(1) })
  })
}

/** 关注 UP主：调 Python ups.py add。 */
function addUpsSubscription(port, midOrUrl) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['-m', 'engine.ups', 'add', String(midOrUrl)],
      { cwd: path.join(WORKER_ROOT, 'worker'), env: baseEnv(port), stdio: 'inherit' })
    child.on('exit', (code) => resolve(code || 0))
    child.on('error', (err) => { console.error('[supervisor] ups add failed', err.message); resolve(1) })
  })
}

/** 取消关注 UP主。 */
function removeUpsSubscription(port, midOrUrl) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['-m', 'engine.ups', 'remove', String(midOrUrl)],
      { cwd: path.join(WORKER_ROOT, 'worker'), env: baseEnv(port), stdio: 'inherit' })
    child.on('exit', (code) => resolve(code || 0))
    child.on('error', (err) => { console.error('[supervisor] ups remove failed', err.message); resolve(1) })
  })
}

/** 列出已关注UP主（读SQLite）。 */
function listUpsSubscriptions(port) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ['-c', `
import sqlite3, json
from engine.schema import DB_PATH, init_db
from engine.ups import list_ups
con = init_db()
ups = list_ups(con)
print(json.dumps(ups, ensure_ascii=False))
con.close()
`], { cwd: path.join(WORKER_ROOT, 'worker'), env: baseEnv(port) })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', () => {})
    child.on('exit', () => {
      try { resolve(JSON.parse(out.trim())) } catch (_) { resolve([]) }
    })
  })
}

module.exports = { spawnWorker, startDiscoveryScheduler, runDiscoveryOnce, runUpsCrawl, addUpsSubscription, removeUpsSubscription, listUpsSubscriptions }

# 庖丁解牛多渠道发现与统一教程后台 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建渠道抽象层、三种发现模式、UP主订阅管理、统一教程库Dashboard、LLM prompt扩展和菜品字典模糊归类。

**Architecture:** 在现有单容器架构上做最小侵入性扩展：新增 `src/channels/` 渠道适配层，改造 `tutorials.js` 去掉硬编码的 bvid/bilibili，重构Dashboard发现页和教程库页面，扩展Python worker的LLM prompt注入元数据和评论。

**Tech Stack:** Node.js (server.js/tutorials.js), Python 3 (worker/engine), 微信云开发 (cloudbase), bilibili-api, Anthropic/OpenAI-compatible LLM provider

## Global Constraints

- 所有渠道特有逻辑收敛在 `src/channels/`，其他模块通过 `index.js` 路由调用
- `bvid` 字段删除，统一用 `sourceId`；`platform` → `channelType`
- 现有数据做向后兼容迁移：bvid→sourceId, platform→channelType
- Dashboard页面延续现有暖色调视觉风格（coral/#d9694d, paper/#fffdf8）
- 云数据库是教程状态的唯一权威来源
- 小程序只读取PUBLISHED数据，不接触worker和原始视频

---

## File Map

```
CREATE:
  src/channels/index.js           # 渠道注册 + 路由分发
  src/channels/bilibili.js        # B站渠道适配器

MODIFY:
  src/tutorials.js                # 去掉硬编码bvid/bilibili，走channel层
  src/server.js                   # Dashboard: 发现页重构(3Tab) + 统一教程库 + 菜品字典
  src/supervisor.js               # UP主关注操作（添加/取消/拉取）
  worker/discovery_push.py        # UP主crawl模式 + 抓取评论存入sourceData
  worker/engine/extract_steps.py  # LLM prompt注入简介+高赞评论
  worker/paoding_worker.py        # 传递sourceData到extract_steps
  cloudfunctions/tutorials/index.js  # bvid→sourceId, channelType字段
  miniprogram/utils/tutorials.ts     # 类型更新: bvid→sourceId
```

---

### Task 1: 渠道抽象层 —— `src/channels/`

**Files:**
- Create: `services/recipe-publisher/src/channels/index.js`
- Create: `services/recipe-publisher/src/channels/bilibili.js`

**Interfaces:**
- Produces: `getChannel(channelType)` → channel adapter object
- Produces: `listChannels()` → array of {channelType, label}
- Produces: `parseSourceId(channelType, input)` → sourceId
- Produces: `buildSourceUrl(channelType, sourceId)` → url
- Produces: `evaluateCookingTutorial(channelType, sourceMeta)` → PreflightResult
- Produces: `getDiscoveryModes(channelType)` → array of mode descriptors
- Produces: `getDiscoveryConfig(channelType)` → {rankingSources, searchKeywords, ...}

- [ ] **Step 1: Create `src/channels/index.js` — 渠道注册与路由**

```js
'use strict'

const channels = {}

function register(adapter) {
  channels[adapter.channelType] = adapter
}

function getChannel(channelType) {
  const ch = channels[channelType]
  if (!ch) throw new Error(`Unknown channel: ${channelType}`)
  return ch
}

function listChannels() {
  return Object.values(channels).map(ch => ({
    channelType: ch.channelType,
    label: ch.label,
  }))
}

// 便捷方法：委托到对应渠道
function parseSourceId(channelType, input) {
  return getChannel(channelType).parseSourceId(input)
}
function buildSourceUrl(channelType, sourceId) {
  return getChannel(channelType).buildSourceUrl(sourceId)
}
function evaluateCookingTutorial(channelType, sourceMeta) {
  return getChannel(channelType).evaluateCookingTutorial(sourceMeta)
}
function getDiscoveryModes(channelType) {
  return getChannel(channelType).discovery.modes
}
function getDiscoveryConfig(channelType) {
  return getChannel(channelType).discovery
}

// 自注册
register(require('./bilibili'))

module.exports = { register, getChannel, listChannels, parseSourceId, buildSourceUrl, evaluateCookingTutorial, getDiscoveryModes, getDiscoveryConfig }
```

- [ ] **Step 2: Create `src/channels/bilibili.js` — B站渠道适配器**

```js
'use strict'

const BVID_REGEX = /^BV[0-9A-Za-z]+$/
const POSITIVE = ['教程', '做法', '菜谱', '配方', '步骤', '做饭', '烹饪', '家常菜', 'recipe', 'how to cook']
const NEGATIVE = ['吃播', '试吃', '测评', '开箱', '搞笑', '段子', 'vlog', '探店', '踩雷', '整活', 'reaction', '直播回放', '搬运']
const COOKING_CATEGORIES = ['美食', '美食制作', '生活']

function parseSourceId(input) {
  const trimmed = String(input || '').trim()
  if (BVID_REGEX.test(trimmed)) return trimmed
  const match = trimmed.match(/(BV[0-9A-Za-z]+)/)
  if (match) return match[1]
  throw new Error(`无法从 "${trimmed}" 解析出 B站 BV 号`)
}

function buildSourceUrl(sourceId) {
  return `https://www.bilibili.com/video/${sourceId}`
}

function evaluateCookingTutorial(sourceMeta = {}) {
  const title = String(sourceMeta.title || '').trim()
  const description = String(sourceMeta.description || sourceMeta.desc || '').trim()
  const tags = Array.isArray(sourceMeta.tags) ? sourceMeta.tags.join(' ') : String(sourceMeta.tags || '')
  const category = String(sourceMeta.category || sourceMeta.tname || '')
  const duration = Number(sourceMeta.durationSeconds || sourceMeta.duration || 0)
  const text = `${title} ${description} ${tags}`.toLowerCase()
  const reasons = []

  if (!title) return { verdict: 'METADATA_INCOMPLETE', score: 0, reasons: ['缺少视频标题'] }
  if (NEGATIVE.some(w => text.includes(w))) return { verdict: 'REJECTED', score: 0, reasons: ['命中非教程内容排除词'] }
  if (duration && (duration < 45 || duration > 3600)) return { verdict: 'REJECTED', score: 0, reasons: ['时长不在45秒至60分钟范围'] }

  let score = 0
  if (POSITIVE.some(w => text.includes(w))) { score += 55; reasons.push('标题/描述/标签含做菜教程信号') }
  if (COOKING_CATEGORIES.some(w => category.includes(w))) { score += 20; reasons.push('B站分区为美食相关') }
  if (duration >= 60 && duration <= 1800) { score += 15; reasons.push('时长适合步骤型教程') }
  if (/(食材|下锅|翻炒|切|腌|炖|蒸|烤|出锅)/.test(text)) { score += 15; reasons.push('存在烹饪动作或食材信号') }

  if (score >= 60) return { verdict: 'PASSED', score, reasons }
  return { verdict: 'MANUAL_REVIEW_REQUIRED', score, reasons: [...reasons, '元数据不足以确认是正常做饭教程'] }
}

module.exports = {
  channelType: 'bilibili',
  label: 'B站',

  parseSourceId,
  buildSourceUrl,
  evaluateCookingTutorial,

  discovery: {
    modes: [
      {
        key: 'ranking',
        label: '榜单发现',
        params: [
          { key: 'source', label: '来源', type: 'select',
            options: [
              { value: 'food_3day', label: '美食三日榜' },
              { value: 'historical', label: '历史优质（关键词搜索）' },
              { value: 'auto', label: '两者合并' },
            ] },
          { key: 'limit', label: '数量', type: 'number', defaultValue: 30 },
        ],
      },
      {
        key: 'up_subscription',
        label: 'UP主关注',
        params: [],
      },
      {
        key: 'direct',
        label: '指定素材',
        params: [
          { key: 'input', label: 'BV号/链接', type: 'textarea',
            placeholder: '每行一个BV号或B站视频链接，空格分隔' },
        ],
      },
    ],
    rankingSources: ['food_3day'],
    searchKeywords: ['菜谱', '家常菜教程', '做饭教程'],
  },
}
```

- [ ] **Step 3: Verify** — 在 `services/recipe-publisher/` 下运行 node 验证模块可加载：

```bash
cd services/recipe-publisher && node -e "
const ch = require('./src/channels');
console.log('channels:', JSON.stringify(ch.listChannels()));
console.log('parse:', ch.parseSourceId('bilibili', 'BV1xx4y1B7Ea'));
console.log('modes:', ch.getDiscoveryModes('bilibili').map(m=>m.key));
"
```

Expected output: channels list, BV号解析结果, 三个mode key

- [ ] **Step 4: Commit**

```bash
git add services/recipe-publisher/src/channels/
git commit -m "feat: add channel abstraction layer with bilibili adapter"
```

---

### Task 2: 更新 `tutorials.js` —— 去掉硬编码 bvid/bilibili

**Files:**
- Modify: `services/recipe-publisher/src/tutorials.js`

**Interfaces:**
- Consumes: `require('./channels')` — parseSourceId, buildSourceUrl, evaluateCookingTutorial
- Produces: Same `TutorialService` class — `submitSource()` replaces `submitBilibili()`, signature changes

- [ ] **Step 1: 重写 `bvidFrom()` → 改用 channel 层**

Replace lines 1-18 (requires + constants + bvidFrom):

```js
'use strict'

const { ValidationError } = require('./validator')
const { parseSourceId, buildSourceUrl, evaluateCookingTutorial, getChannel } = require('./channels')

const OWNER_TYPES = new Set(['SYSTEM', 'USER'])
const VISIBILITIES = new Set(['PRIVATE', 'SHARE_PENDING', 'SHARED', 'PUBLIC'])

function now() { return new Date() }
```

- [ ] **Step 2: 替换 `submitBilibili()` → `submitSource()`**

Replace the submitBilibili method (lines 56-76):

```js
  async submitSource(input, actor = 'system') {
    const channelType = input.channelType || 'bilibili'
    const channel = getChannel(channelType)
    const ownerType = input.ownerType || 'USER'
    if (!OWNER_TYPES.has(ownerType)) throw new ValidationError(['ownerType 仅支持 SYSTEM 或 USER'])
    if (ownerType === 'USER' && !input.ownerId) throw new ValidationError(['用户教程必须提供 ownerId'])

    const sourceId = parseSourceId(channelType, input.sourceId || input.sourceUrl || input.bvid)
    const sourceUrl = input.sourceUrl || channel.buildSourceUrl(sourceId)
    const tutorialId = `tutorial_${channelType}_${sourceId}_${ownerType === 'USER' ? String(input.ownerId).slice(0, 32) : 'system'}`

    const current = await this.findOne('tutorials', { tutorialId })
    if (current) return current

    const visibility = ownerType === 'SYSTEM' ? 'PUBLIC' : 'PRIVATE'
    const tutorial = await this.upsert('tutorials', { tutorialId }, {
      channelType,
      sourceId,
      sourceUrl,
      sourceMeta: input.sourceMeta || {},
      sourceData: input.sourceData || {},
      sourceTitle: '',
      ownerType,
      ownerId: input.ownerId || null,
      discoverSource: input.discoverSource || 'direct',
      visibility,
      requestedVisibility: visibility,
      lifecycleStatus: 'PREFLIGHT_PENDING',
      processingStatus: 'NOT_QUEUED',
      reviewPolicy: ownerType === 'SYSTEM' ? 'SYSTEM_REQUIRED' : 'OWNER_REQUIRED',
      currentVersionId: null,
      currentPublishedVersionId: null,
      revisionCount: 0,
      sourceRightsStatus: input.sourceRightsStatus || 'unknown',
    })
    await this.event(tutorialId, 'SUBMITTED', actor, { ownerType, channelType, sourceId })
    return tutorial
  }
```

- [ ] **Step 3: 更新 `preflight()` — 去掉 platform 硬编码**

Replace lines 78-90 (preflight method), change `tutorial.platform !== 'bilibili'` check:

```js
  async preflight(tutorialId, metadata, actor = 'discovery-worker') {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    const channel = getChannel(tutorial.channelType)
    const result = channel.evaluateCookingTutorial(metadata)
    // ... rest unchanged, but replace sourceTitle assignment:
    const updated = await this.db.collection('tutorials').doc(tutorial._id).update({ data: {
      sourceTitle: metadata.title || tutorial.sourceTitle,
      sourceMeta: { ...(tutorial.sourceMeta || {}), ...metadata },
      sourceData: { ...(tutorial.sourceData || {}), ...(metadata._sourceData || {}) },
      preflight: { ...result, checkedAt: now(), checkedBy: actor },
      lifecycleStatus: state,
      processingStatus: result.verdict === 'PASSED' ? 'READY_TO_QUEUE' : 'BLOCKED',
      updatedAt: now(),
    } })
    await this.event(tutorialId, 'PREFLIGHT_COMPLETED', actor, result)
    return { tutorialId, ...result, lifecycleStatus: state, updated }
  }
```

- [ ] **Step 4: 更新 `submitFrameSelection()` — 去掉 bvid 引用**

Replace `tutorial.bvid` with `tutorial.sourceId` on line 206.

- [ ] **Step 5: 更新 `submitBilibili` → 保留为 `submitSource` 的别名向后兼容**

Add after submitSource:

```js
  // 向后兼容旧 API
  async submitBilibili(input, actor) {
    return this.submitSource({ ...input, channelType: 'bilibili' }, actor)
  }
```

- [ ] **Step 6: Update `server.js` API route** — 将 `/v1/tutorials/bilibili` 端点改为同时支持 `/v1/tutorials/submit`。

Edit `server.js` around line 304-306, add new route:

```js
    // 新接口
    if (req.method === 'POST' && req.url === '/v1/tutorials/submit') {
      return reply(res, 201, { data: await tutorials.submitSource(await readJson(req), actor) })
    }
    // 向后兼容旧接口
    if (req.method === 'POST' && req.url === '/v1/tutorials/bilibili') {
      return reply(res, 201, { data: await tutorials.submitSource({ ...(await readJson(req)), channelType: 'bilibili' }, actor) })
    }
```

- [ ] **Step 7: Run existing tests to verify no regression**

```bash
cd services/recipe-publisher && npm test
```

Expected: All existing tests pass (向后兼容).

- [ ] **Step 8: Commit**

```bash
git add services/recipe-publisher/src/tutorials.js services/recipe-publisher/src/server.js
git commit -m "refactor: replace hardcoded bvid/bilibili with channel abstraction"
```

---

### Task 3: 更新 `discovery_push.py` —— UP主模式 + 评论抓取

**Files:**
- Modify: `services/recipe-publisher/worker/discovery_push.py`

**Interfaces:**
- Consumes: `ups.py` crawl_one function
- Produces: enriched candidate metadata with `_sourceData` containing description, tags, top comments

- [ ] **Step 1: Add `_fetch_comments()` function**

在 `_candidate_metadata()` 函数之前添加：

```python
async def _fetch_top_comments(bvid: str, limit: int = 5) -> list[dict]:
    """拉取视频高赞评论，返回最多 limit 条。"""
    try:
        from bilibili_api.video import Video
        from bilibili_api.comment import get_comments
        v = Video(bvid=bvid)
        info = await v.get_info()
        oid = info.get("aid") or info.get("id") or 0
        if not oid:
            return []
        comments = await get_comments(
            oid=oid,
            type_=1,       # 1=视频评论
            order=1,       # 1=按热度排序
            page_index=1,
        )
        items = []
        for c in (comments.get("replies") or [])[:limit]:
            items.append({
                "content": (c.get("content") or {}).get("message", ""),
                "likes": c.get("like", 0),
                "user": (c.get("member") or {}).get("uname", ""),
            })
        return items
    except Exception:
        return []
```

- [ ] **Step 2: Update `_candidate_metadata()` to include sourceData**

Replace `_candidate_metadata()`:

```python
async def _candidate_metadata(item: dict, fetch_comments: bool = True) -> dict:
    """把 rank / search 归一化 item 映射成控制面 preflight 需要的元数据。
    额外拉取评论存入 _sourceData，供拆解环节使用。
    """
    stat = item.get("stat", {}) or {}
    owner = item.get("owner", {}) or {}
    tag = item.get("tag", "")
    tags = [t.strip() for t in tag.split(",")] if isinstance(tag, str) and tag else (tag if isinstance(tag, list) else [])
    bvid = item.get("bvid", "")

    # 拉取高赞评论
    top_comments = []
    if fetch_comments and bvid:
        top_comments = await _fetch_top_comments(bvid)

    metadata = {
        "title": item.get("title", ""),
        "description": item.get("desc") or item.get("description", ""),
        "tags": tags,
        "category": item.get("tname_v2") or item.get("tname") or item.get("typename", ""),
        "durationSeconds": int(item.get("duration", 0) or 0),
        "authorName": owner.get("name", ""),
        "viewCount": stat.get("view", 0),
        # 供拆解环节使用的额外上下文
        "_sourceData": {
            "description": item.get("desc") or item.get("description", ""),
            "tags": tags,
            "title": item.get("title", ""),
            "topComments": top_comments,
        },
    }
    return metadata
```

- [ ] **Step 3: Add UP主 crawl mode to `run()` function**

在 `run()` 的 `if tokens:` 分支之后、`if not candidates:` 之前增加 UP主模式：

```python
    # UP主模式：拉取已关注UP主的新视频
    if source == "ups":
        import sqlite3 as _sqlite3
        from engine.schema import DB_PATH
        db_con = _sqlite3.connect(DB_PATH)
        try:
            from engine.ups import crawl_all as ups_crawl_all
            results = ups_crawl_all(db_con, days=90, only_cooking=True, max_results=30, pages=2)
            for r in results:
                if r.get("status") == "ok":
                    # crawl_all 内部已通过 add_one_bvid 入库新视频
                    # 这里只需要把新增的视频推送到控制面
                    pass
            # 从SQLite读取本次新发现的视频
            mids = [r["mid"] for r in results if r.get("status") == "ok"]
            if mids:
                placeholders = ",".join("?" * len(mids))
                new_videos = db_con.execute(
                    f"SELECT bvid,title FROM videos WHERE up_mid IN ({placeholders}) AND discovered_via='ups' AND processing_status='new'",
                    mids,
                ).fetchall()
                for bvid, title in new_videos:
                    try:
                        info = asyncio.run(add_video._fetch_video_info(bvid))
                        candidates.append((bvid, await _candidate_metadata(info, fetch_comments=True)))
                    except Exception as exc:
                        print(f"  跳过 {bvid}: {exc}", file=sys.stderr)
        finally:
            db_con.close()
```

- [ ] **Step 4: Register `ups` as a valid source choice in argparse**

```python
    parser.add_argument("--source", choices=("auto", "food_3day", "historical", "ups"), default="food_3day")
```

And update `_fetch_candidates` to handle `ups`:

```python
async def _fetch_candidates(source: str, limit: int) -> list[dict]:
    if source == "food_3day":
        items = await discover_cooking.fetch_ranking()
    elif source == "historical":
        items = await discover_cooking.fetch_historical()
    elif source == "ups":
        # ups 模式在 run() 中单独处理，这里返回空列表
        return []
    elif source == "auto":
        # ... existing auto logic
```

- [ ] **Step 5: Commit**

```bash
git add services/recipe-publisher/worker/discovery_push.py
git commit -m "feat: add UP主 crawl mode and comment fetching to discovery_push"
```

---

### Task 4: 更新 `supervisor.js` —— UP主操作

**Files:**
- Modify: `services/recipe-publisher/src/supervisor.js`

**Interfaces:**
- Produces: `runUpsCrawl(port)` — crawl all subscribed UP主
- Produces: `addUpsSubscription(port, midOrUrl)` — add UP主
- Produces: `removeUpsSubscription(port, midOrUrl)` — remove UP主
- Produces: `listUpsSubscriptions(port)` — list subscriptions

- [ ] **Step 1: Add UP主 management functions to supervisor.js**

Add after `runDiscoveryOnce`:

```js
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
```

- [ ] **Step 2: Add UP主 Dashboard routes to server.js**

In server.js, add after the discover POST route (around line 268):

```js
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
```

- [ ] **Step 3: Commit**

```bash
git add services/recipe-publisher/src/supervisor.js services/recipe-publisher/src/server.js
git commit -m "feat: add UP主 management operations to supervisor and dashboard routes"
```

---

### Task 5: Dashboard 发现页重构 —— 三Tab + UP主管理

**Files:**
- Modify: `services/recipe-publisher/src/server.js` — replace `dashboardDiscoverPage()`

This is the largest UI change. The `dashboardDiscoverPage()` function is completely rewritten.

- [ ] **Step 1: Replace `dashboardDiscoverPage()` with new three-tab version**

Replace the existing `dashboardDiscoverPage()` function (lines 133-138) and add helper: `dashboardUpsTab()`.

The new page includes:
- Channel selector at top
- Three tabs (榜单发现 / UP主关注 / 指定素材)
- Preflight results table with checkboxes and batch enqueue
- UP主 list with stats, add/remove forms, crawl button

```js
function dashboardDiscoverPage(message, channelType = 'bilibili', activeTab = 'ranking', preflightResults = [], upsList = []) {
  const channels = require('./channels').listChannels()
  const channel = require('./channels').getChannel(channelType)
  const modes = channel.discovery.modes

  // Channel selector
  const channelOpts = channels.map(ch =>
    `<option value="${html(ch.channelType)}" ${ch.channelType === channelType ? 'selected' : ''}>${html(ch.label)}</option>`
  ).join('')

  // Tab bar
  const tabs = modes.map(m =>
    `<a href="?channel=${html(channelType)}&tab=${html(m.key)}" class="tab ${m.key === activeTab ? 'active' : ''}">${html(m.label)}</a>`
  ).join('')

  const note = message ? `<div class="msg">${html(message)}</div>` : ''

  // --- Ranking tab ---
  let rankingTab = ''
  if (activeTab === 'ranking') {
    const rankingMode = modes.find(m => m.key === 'ranking')
    rankingTab = `
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

    // Preflight results table
    if (preflightResults.length > 0) {
      const rows = preflightResults.map(r => {
        const passed = r.verdict === 'PASSED'
        return `<tr>
          <td>${passed ? `<input type="checkbox" name="tids" value="${html(r.tutorialId)}">` : ''}</td>
          <td><a target="_blank" href="${html(r.sourceUrl || '#')}">${html(r.sourceTitle || r.sourceId)}</a></td>
          <td><small>${html(r.sourceId)}</small></td>
          <td>${badge(r.verdict)}</td>
          <td>${r.score != null ? r.score : '—'}</td>
        </tr>`
      }).join('')
      rankingTab += `
      <section>
        <h2>预检结果</h2>
        <form method="post" action="/dashboard/discover/enqueue-batch">
          <table><thead><tr><th>选</th><th>标题</th><th>ID</th><th>预检</th><th>评分</th></tr></thead>
          <tbody>${rows}</tbody></table>
          <div style="margin-top:12px">
            <button type="button" onclick="document.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=true)">全选PASSED</button>
            <button type="submit">批量入队</button>
          </div>
        </form>
      </section>`
    }
  }

  // --- UP主 tab ---
  let upsTab = ''
  if (activeTab === 'up_subscription') {
    upsTab = `
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
      const rows = upsList.map(u => `<tr>
        <td><strong>${html(u.name || 'UP_'+u.mid)}</strong><br><small>mid: ${html(String(u.mid))}</small></td>
        <td>${u.n_approved || 0}✓ / ${u.n_pending || 0}… / ${u.n_total || 0}总</td>
        <td>${u.last_checked_at ? String(u.last_checked_at).slice(0,19) : '—'}</td>
        <td>${u.last_video_bvid ? `<a target="_blank" href="https://www.bilibili.com/video/${html(u.last_video_bvid)}">${html(u.last_video_bvid)}</a>` : '—'}</td>
        <td><form method="post" action="/dashboard/ups/remove" onsubmit="return confirm('取消关注？')"><input type="hidden" name="mid" value="${html(String(u.mid))}"><button class="btn-sm" style="background:#ad4d39">取消关注</button></form></td>
      </tr>`).join('')
      upsTab += `
      <section>
        <h2>已关注 ${upsList.length} 个UP主</h2>
        <table><thead><tr><th>UP主</th><th>视频统计</th><th>上次检查</th><th>最新视频</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </section>`
    }
  }

  // --- Direct tab ---
  let directTab = ''
  if (activeTab === 'direct') {
    directTab = `
    <section>
      <h2>指定素材</h2>
      <form method="post" action="/dashboard/discover/run">
        <input type="hidden" name="channelType" value="${html(channelType)}">
        <textarea name="bvids" placeholder="每行一个BV号或B站视频链接" rows="5" style="width:100%;font:inherit;padding:8px;border:1px solid #cfc1ad;border-radius:8px"></textarea>
        <button type="submit" style="margin-top:10px">加入并预检</button>
      </form>
    </section>`
  }

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>发现 · 庖丁解牛</title><style>
  :root{--ink:#342a24;--paper:#fffdf8;--line:#eadcc8;--coral:#d9694d;--green:#618c55;--amber:#b87825}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;background:#f8f1e4;color:var(--ink)}main{max-width:1100px;margin:auto;padding:32px 22px 64px}a{color:#bd573f}h1{margin-bottom:4px}.channel-bar{display:flex;align-items:center;gap:16px;margin:14px 0}.channel-bar select{height:38px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px;font:inherit}.tabs{display:flex;gap:4px;margin:18px 0}.tab{padding:8px 18px;border:1px solid var(--line);border-radius:10px 10px 0 0;text-decoration:none;color:var(--ink);background:#f0e6d7;font-size:14px}.tab.active{background:var(--paper);border-bottom-color:var(--paper);font-weight:700;color:var(--coral)}section{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 18px;overflow:auto}h2{font-size:17px;margin:0 0 12px}table{width:100%;border-collapse:collapse;min-width:600px}th,td{padding:10px;border-bottom:1px solid #f0e6d7;text-align:left;font-size:13px;vertical-align:top}th{color:#806f61;background:#fff8ec}.badge{font-size:11px;border-radius:999px;padding:3px 8px;background:#eee3d2;color:#5c4b3f;white-space:nowrap}.badge.PASSED,.badge.preflight_passed{background:#e4f1df;color:#417138}.badge.REJECTED,.badge.preflight_rejected{background:#f9dfd8;color:#a8432f}.badge.MANUAL_REVIEW_REQUIRED,.badge.METADATA_INCOMPLETE{background:#fff0d4;color:#9a661a}.msg{background:#e4f1df;color:#417138;border:1px solid #bcd9b0;padding:10px 12px;border-radius:9px;margin-bottom:14px}button{background:var(--coral);color:#fff;border:0;border-radius:9px;padding:10px 18px;cursor:pointer;font:inherit}button:hover{opacity:0.9}input,textarea,select{font:inherit}.inline-form{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.inline-form input,.inline-form select{height:38px;border:1px solid #cfc1ad;border-radius:8px;padding:0 10px}.btn-sm{padding:6px 12px;font-size:12px;border-radius:7px}@media(max-width:700px){main{padding:16px}}</style>
  <main><p><a href="/dashboard">← 返回后台</a></p><h1>发现教程素材</h1>
  <div class="channel-bar">渠道:
    <form method="get" action="/dashboard/discover" style="display:inline">
      <select name="channel" onchange="this.form.submit()">${channelOpts}</select>
      <input type="hidden" name="tab" value="${html(activeTab)}">
    </form>
  </div>
  <div class="tabs">${tabs}</div>
  ${note}${rankingTab}${upsTab}${directTab}</main></html>`
}
```

- [ ] **Step 2: Update the `/dashboard/discover` GET route** to accept query params and render UP主 data

Replace the existing discover GET route (lines 255-259):

```js
    if (req.method === 'GET' && req.url.match(/^\/dashboard\/discover/)) {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const url = new URL(req.url, 'http://localhost')
      const channelType = url.searchParams.get('channel') || 'bilibili'
      const activeTab = url.searchParams.get('tab') || 'ranking'
      const msg = url.searchParams.get('msg') || ''

      // 获取UP主列表
      let upsList = []
      try {
        const { listUpsSubscriptions } = require('./supervisor')
        upsList = await listUpsSubscriptions(port)
      } catch (_) {}

      // 获取最近的预检结果（从 tutorials 集合查最近创建的）
      let preflightResults = []
      try {
        const recent = await tutorials.list(50)
        preflightResults = recent.map(t => ({
          tutorialId: t.tutorialId,
          sourceId: t.sourceId,
          sourceTitle: t.sourceTitle,
          sourceUrl: t.sourceUrl,
          verdict: t.preflight?.verdict || t.lifecycleStatus,
          score: t.preflight?.score,
        }))
      } catch (_) {}

      return res.end(dashboardDiscoverPage(msg, channelType, activeTab, preflightResults, upsList))
    }
```

- [ ] **Step 3: Add batch enqueue route**

```js
    if (req.method === 'POST' && req.url === '/dashboard/discover/enqueue-batch') {
      if (!isDashboardAuthorized(req)) { res.writeHead(303, { location: '/dashboard/login' }); return res.end() }
      const form = await readForm(req)
      const tids = Array.isArray(form.tids) ? form.tids : (form.tids ? [form.tids] : [])
      for (const tid of tids) {
        try { await tutorials.enqueue(tid, dashboardUser || 'content-admin') } catch (e) { console.error('[paoding-jieniu] batch enqueue failed for', tid, e.message) }
      }
      res.writeHead(303, { location: `/dashboard/discover?msg=已入队${tids.length}个教程` }); return res.end()
    }
```

- [ ] **Step 4: Commit**

```bash
git add services/recipe-publisher/src/server.js
git commit -m "feat: redesign discover page with 3 tabs, UP主 mgmt, and batch enqueue"
```

---

### Task 6: 统一教程库 Dashboard

**Files:**
- Modify: `services/recipe-publisher/src/server.js` — replace `dashboardPage()` and `dashboardTutorialPage()`

- [ ] **Step 1: Replace `dashboardPage()` with unified tutorial library**

Replace lines 91-99 with a version that shows a single unified table with filters:

```js
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
  <main><div class="hero"><div class="eyebrow">庖丁解牛 · 内容控制台</div><h1>教程库</h1><p class="sub">多渠道做饭教程的发现、拆解、审核与发布。统一管理每个教程的完整生命周期。</p><form method="post" action="/dashboard/logout" style="margin-top:14px"><button style="border:0;background:none;padding:0;color:#8a6554;text-decoration:underline;cursor:pointer">退出登录</button></form></div><nav><a class="active" href="/dashboard">教程库</a><a href="/dashboard/discover">发现</a><a href="/dashboard/dictionary">菜品字典</a></nav>
  <section>${filterBar}<table><thead><tr><th>教程 / 来源</th><th>归属</th><th>状态</th><th>可见性</th><th>版本数</th><th>最近更新</th></tr></thead><tbody>${table || '<tr><td colspan="6">暂无教程。去<a href="/dashboard/discover">发现页</a>添加。</td></tr>'}</tbody></table></section></main></html>`
}
```

- [ ] **Step 2: Update `/dashboard` GET route** to support filtering

Replace the existing route (lines 212-215):

```js
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
```

- [ ] **Step 3: Update `dashboardTutorialPage()` to show channel info and sourceId**

Replace bvid references in lines 128-131. Change `t.bvid` → `t.sourceId`, `t.sourceUrl` is now used directly:

```js
  return `...<h1>${html(t.sourceTitle || t.sourceId)}</h1>
  <p>来源：${html(t.channelType)} · <a target="_blank" href="${html(t.sourceUrl)}">${html(t.sourceId)}</a> · ${badge(t.ownerType)} · ${badge(t.lifecycleStatus)} · 可见性 ${badge(t.visibility)}</p>
  ...`
```

- [ ] **Step 4: Commit**

```bash
git add services/recipe-publisher/src/server.js
git commit -m "feat: unify tutorial library with filters, channel-aware detail page"
```

---

### Task 7: LLM Prompt 扩展 —— 注入视频简介和评论

**Files:**
- Modify: `services/recipe-publisher/worker/engine/extract_steps.py`

- [ ] **Step 1: Update `USER_PROMPT_TEMPLATE` to include metadata and comments**

Replace `USER_PROMPT_TEMPLATE` (lines 39-85):

```python
USER_PROMPT_TEMPLATE = """## 任务

解析下面这段做菜视频的口播文稿，输出结构化 JSON。

## 文稿格式

`[start_sec - end_sec] 文本`  每行一段。

## 视频信息（辅助参考）

标题：{title}
简介：{description}
标签：{tags}

## 观众高赞评论（可能有补充技巧或替代做法，请酌情参考）

{comments}

## 输出 JSON Schema

```json
{{
  "recipe_name": "菜名（如'糖醋里脊'）",
  "ingredients": [
    {{"name": "食材名", "amount": "量（如'300g'、'2勺'）", "note": "预处理备注（可选）"}}
  ],
  "steps": [
    {{
      "index": 0,
      "name": "步骤名（动词短语，如'切肉'、'热锅'、'翻炒'）",
      "description": "步骤详细描述（1-2 句话）",
      "start_sec": 0.0,
      "end_sec": 0.0,
      "key_frame_sec": 0.0,
      "key_visual_hint": "这一帧画面应该看到什么（如'刀切肉片的特写'）"
    }}
  ],
  "tips": [
    {{"content": "实用技巧（如'炒糖色要小火慢炒'）", "source": "comment 或 transcript"}}
  ]
}}
```

## 关键规则

1. **key_frame_sec** 是**画面最具代表性**的瞬间 —— 通常是动手操作的关键帧（刀落、锅起、食材变色），不是话语开始/结束
2. **步骤拆分**：按"动作切换"拆，不要按"句子切换"拆
3. **时间戳严格对齐**：用文稿里实际出现的时间，不要瞎猜
4. **食材归一**：同名食材合并（如"生抽"和"酱油"统一为"生抽"）
5. **数量写原文**：amount 保留原话（"适量"、"少许"、"两勺"都可以）
6. **过滤口播冗余**：忽略"大家好"、"记得点赞"这类非操作内容
7. **tips 提取**：从评论和口播中提取对做菜有实际帮助的技巧。标记来源（transcript 或 comment）

## 文稿（bvid={bvid}）

```
{transcript}
```
"""
```

- [ ] **Step 2: Update `call_llm()` to accept and inject extra fields**

Replace `call_llm()` (lines 101-112):

```python
def call_llm(transcript_text: str, bvid: str, model: str = DEFAULT_MODEL,
             title: str = "", description: str = "", tags: str = "",
             top_comments: list | None = None) -> dict:
    """调 LLM，返回解析后的 dict。可注入视频元数据和评论辅助提取。"""
    # 格式化评论
    comments_text = ""
    if top_comments:
        comments_lines = []
        for c in top_comments:
            likes = c.get("likes", 0)
            content = c.get("content", "")
            if content:
                comments_lines.append(f"- {content} (点赞 {likes})")
        comments_text = "\n".join(comments_lines) if comments_lines else "（无高赞评论）"
    else:
        comments_text = "（未获取评论数据）"

    user_msg = USER_PROMPT_TEMPLATE.format(
        bvid=bvid,
        transcript=transcript_text,
        title=title or "（未知）",
        description=description or "（未提供）",
        tags=tags or "（未提供）",
        comments=comments_text,
    )
    text = llm_provider.chat(SYSTEM_PROMPT, user_msg, model=model).strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)
```

- [ ] **Step 3: Update `extract_one()` to pass sourceData from the tutorial**

Update the function signature and body (lines 115-165):

```python
def extract_one(bvid: str, con: sqlite3.Connection,
                model: str = DEFAULT_MODEL,
                overwrite: bool = False,
                source_data: dict | None = None) -> dict:
    """读 transcript → 调 LLM → 落库。可注入 sourceData 辅助提取。"""
    # ... existing file read logic ...

    transcript_text = format_transcript(data)
    parsed = call_llm(
        transcript_text, bvid, model=model,
        title=(source_data or {}).get("title", ""),
        description=(source_data or {}).get("description", ""),
        tags=", ".join((source_data or {}).get("tags", [])),
        top_comments=(source_data or {}).get("topComments", []),
    )
    # ... rest unchanged ...
```

- [ ] **Step 4: Commit**

```bash
git add services/recipe-publisher/worker/engine/extract_steps.py
git commit -m "feat: extend LLM prompt with video metadata and top comments"
```

---

### Task 8: Worker 传递 sourceData

**Files:**
- Modify: `services/recipe-publisher/worker/paoding_worker.py`

- [ ] **Step 1: Pass sourceData from tutorial to extract_steps**

In the PROCESS handler, after fetching the tutorial, pass `sourceData`:

Find the section in `paoding_worker.py` where `extract_one` is called (around the process pipeline), and add:

```python
# 从控制面获取 sourceData（含标题/简介/评论）
source_data = None
try:
    tutorial_resp = requests.get(
        f"{api_base}/v1/tutorials/{tutorial_id}",
        headers=headers,
        timeout=10,
    )
    tutorial_detail = tutorial_resp.json().get("data", {})
    tutorial = tutorial_detail.get("tutorial", {})
    source_data = tutorial.get("sourceData") or tutorial.get("sourceMeta") or {}
except Exception:
    pass

# 传给 extract_one
extract_steps.extract_one(bvid, con, model=model, overwrite=overwrite, source_data=source_data)
```

Note: The exact integration point in paoding_worker.py depends on the current flow structure. The key is that `source_data` is fetched from the tutorial API and passed to `extract_one()`.

- [ ] **Step 2: Commit**

```bash
git add services/recipe-publisher/worker/paoding_worker.py
git commit -m "feat: pass tutorial sourceData to extract_steps for enriched LLM prompt"
```

---

### Task 9: 菜品字典模糊匹配

**Files:**
- Modify: `services/recipe-publisher/src/tutorials.js` — add `matchDish()` method
- Create: `services/recipe-publisher/worker/engine/dish_matcher.py` (optional, could also be Node-side)

Since dish matching runs at review time in the Dashboard (Node.js side), implement in `tutorials.js`:

- [ ] **Step 1: Add fuzzy dish matching to `tutorials.js`**

Add a new method and helper to `TutorialService`:

```js
  // ——— 菜品模糊匹配 ———
  // 基于菜名 + 食材签名计算相似度，返回候选菜品列表
  async matchDish(recipeName, ingredients = []) {
    const allDishes = await this.db.collection('dish_dictionary').limit(200).get()
    const dishes = allDishes.data

    const results = dishes.map(dish => {
      let score = 0
      const reasons = []

      // 1) 菜名完全匹配
      if (dish.canonicalName === recipeName) { score += 100; reasons.push('菜名完全匹配') }
      // 2) 别名匹配
      else if ((dish.aliases || []).some(a => a === recipeName)) { score += 95; reasons.push('别名匹配') }
      // 3) 子串匹配
      else if (dish.canonicalName.includes(recipeName) || recipeName.includes(dish.canonicalName)) {
        score += 70; reasons.push('菜名包含关系')
      }
      // 4) 别名子串
      else if ((dish.aliases || []).some(a => recipeName.includes(a) || a.includes(recipeName))) {
        score += 60; reasons.push('别名包含关系')
      }

      // 5) 食材签名 Jaccard 相似度
      const dishSigs = dish.ingredientSignature || []
      const recipeSigs = ingredients.map(i => (i.canonicalName || i.rawName || '').toLowerCase())
      if (dishSigs.length > 0 && recipeSigs.length > 0) {
        const intersection = dishSigs.filter(s => recipeSigs.some(r => r.includes(s) || s.includes(r)))
        const union = new Set([...dishSigs, ...recipeSigs])
        const jaccard = intersection.length / union.size
        score += Math.round(jaccard * 50)
        if (jaccard > 0.5) reasons.push(`食材重合度${Math.round(jaccard*100)}%`)
      }

      return { dish, score, reasons }
    })

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, 5).filter(r => r.score > 20)
  }
```

- [ ] **Step 2: Add matchDish API endpoint to server.js**

```js
    if (req.method === 'GET' && req.url.match(/^\/v1\/dishes\/match/)) {
      const url = new URL(req.url, 'http://localhost')
      const name = url.searchParams.get('name') || ''
      const ingredients = url.searchParams.get('ingredients') || ''
      const ingList = ingredients ? ingredients.split(',').map(s => ({ rawName: s.trim() })) : []
      return reply(res, 200, { data: await tutorials.matchDish(name, ingList) })
    }
```

- [ ] **Step 3: Add dish dictionary management page to Dashboard**

Add a simple `/dashboard/dictionary` page (replacing the old dictionary review queue page) that shows dishes with aliases and allows editing:

The existing `dashboardDictionaryPage` function can be adapted, adding a tab for dish management.

- [ ] **Step 4: Commit**

```bash
git add services/recipe-publisher/src/tutorials.js services/recipe-publisher/src/server.js
git commit -m "feat: add fuzzy dish matching and dictionary management"
```

---

### Task 10: 更新云函数和小程序

**Files:**
- Modify: `cloudfunctions/tutorials/index.js`
- Modify: `miniprogram/utils/tutorials.ts`

- [ ] **Step 1: Update cloud function — bvid → sourceId**

In `cloudfunctions/tutorials/index.js`:

1. `assembleRecipe()` (line 120-121): Change `platform: tutorial.platform` → `channelType: tutorial.channelType`, `bvid: tutorial.bvid` → `sourceId: tutorial.sourceId`
2. `listMine()` (line 155): Change `bvid: t.bvid` → `sourceId: t.sourceId`

```js
// In assembleRecipe():
source: {
  channelType: tutorial.channelType,
  url: tutorial.sourceUrl,
  sourceId: tutorial.sourceId,
  title: tutorial.sourceTitle || '',
},

// In listMine():
return res.data.map((t) => ({
  tutorialId: t.tutorialId,
  sourceId: t.sourceId,
  channelType: t.channelType,
  sourceTitle: t.sourceTitle || t.sourceId,
  lifecycleStatus: t.lifecycleStatus,
  visibility: t.visibility,
  currentVersionId: t.currentVersionId,
  updatedAt: t.updatedAt,
}))
```

- [ ] **Step 2: Update submit action in cloud function**

```js
      case 'submit':
        return { code: 0, data: await callControlPlane('POST', '/v1/tutorials/submit', OPENID, {
          sourceId: event.sourceId || event.bvid,
          sourceUrl: event.sourceUrl,
          channelType: event.channelType || 'bilibili',
          ownerType: 'USER',
          ownerId: OPENID,
        }) }
```

- [ ] **Step 3: Update miniprogram type definitions**

In `miniprogram/utils/tutorials.ts`, update interface:

```ts
export interface ITutorial {
  tutorialId: string
  sourceId: string       // was: bvid
  channelType: string    // was: platform
  sourceTitle: string
  lifecycleStatus: string
  visibility: string
  currentVersionId: string | null
  updatedAt: string
}
```

- [ ] **Step 4: Commit**

```bash
git add cloudfunctions/tutorials/index.js miniprogram/utils/tutorials.ts
git commit -m "refactor: update cloud function and mini-program for channel abstraction"
```

---

### Task 11: 端到端测试与数据迁移

**Files:**
- Modify: `services/recipe-publisher/test/tutorials.test.js`

- [ ] **Step 1: Add channel abstraction test**

```js
test('channel parseSourceId parses BV号', () => {
  const { parseSourceId } = require('../src/channels')
  expect(parseSourceId('bilibili', 'BV1xx4y1B7Ea')).toBe('BV1xx4y1B7Ea')
  expect(parseSourceId('bilibili', 'https://www.bilibili.com/video/BV1xx4y1B7Ea')).toBe('BV1xx4y1B7Ea')
})

test('channel evaluateCookingTutorial rejects non-cooking', () => {
  const { evaluateCookingTutorial } = require('../src/channels')
  const result = evaluateCookingTutorial('bilibili', { title: '美食探店vlog', durationSeconds: 300 })
  expect(result.verdict).toBe('REJECTED')
})

test('submitSource creates tutorial with channelType and sourceId', async () => {
  const svc = new TutorialService({ cloud })
  const t = await svc.submitSource({ channelType: 'bilibili', sourceId: 'BV1test0001', ownerType: 'SYSTEM' }, 'test')
  expect(t.channelType).toBe('bilibili')
  expect(t.sourceId).toBe('BV1test0001')
  expect(t.bvid).toBeUndefined()
})
```

- [ ] **Step 2: Run all tests**

```bash
cd services/recipe-publisher && npm test
```

Expected: All tests pass, including new channel tests.

- [ ] **Step 3: Commit**

```bash
git add services/recipe-publisher/test/
git commit -m "test: add channel abstraction and submitSource tests"
```

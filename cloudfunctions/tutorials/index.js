// cloudfunctions/tutorials/index.js
// 小程序教程接入云函数。
//
// 两类职责：
//   1) 读已发布/自有教程：直接查云数据库（Node 控制面用同一套云集合入库），
//      并把媒体 cloudFileId 换成临时 URL，映射成小程序可直接渲染的结构。
//   2) 治理写操作（提交B站/自审/申请分享公开/发起更新）：代理到 Node 控制面内部 API，
//      以 x-actor-id=openid 表明用户身份；内部令牌只存云函数环境变量，绝不下发小程序。
//
// 客户端调用：wx.cloud.callFunction({ name: 'tutorials', data: { action, ...args } })
//
// 环境变量（云函数配置）：
//   PAODING_API_BASE   Node 控制面地址（云托管公网/内网），如 https://xxx.ap-shanghai.run.tcloudbase.com
//   INGEST_API_TOKEN   控制面内部 Bearer 令牌

const http = require('http')
const https = require('https')
const { URL } = require('url')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const API_BASE = process.env.PAODING_API_BASE || ''
const API_TOKEN = process.env.INGEST_API_TOKEN || ''

// ——— Node 控制面代理 ———
function callControlPlane(method, apiPath, openid, body) {
  return new Promise((resolve, reject) => {
    if (!API_BASE || !API_TOKEN) return reject(new Error('控制面未配置（PAODING_API_BASE / INGEST_API_TOKEN）'))
    const url = new URL(apiPath, API_BASE)
    const payload = body ? JSON.stringify(body) : ''
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(url, {
      method,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${API_TOKEN}`,
        'x-actor-id': openid,
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = data ? JSON.parse(data) : {} } catch (_) { parsed = { raw: data } }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed.data ?? parsed)
        else reject(new Error(`控制面 ${res.statusCode}: ${parsed.message || data || 'error'}`))
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ——— 媒体 cloudFileId → 临时 URL ———
async function resolveUrls(fileIds) {
  const unique = [...new Set(fileIds.filter(Boolean))]
  if (!unique.length) return {}
  const res = await cloud.getTempFileURL({ fileList: unique })
  const map = {}
  for (const item of res.fileList || []) {
    if (item.fileID && item.tempFileURL) map[item.fileID] = item.tempFileURL
  }
  return map
}

// ——— 把版本+步骤+食材映射成小程序渲染结构 ———
async function assembleRecipe(tutorial) {
  const versionId = tutorial.currentPublishedVersionId || tutorial.currentVersionId
  if (!versionId) return null
  const revisionRes = await db.collection('tutorial_revisions').where({ tutorialId: tutorial.tutorialId, versionId }).limit(1).get()
  const revision = revisionRes.data[0]
  const recipeId = revision?.recipeId
  if (!recipeId) return null

  const [recipeRes, versionRes, stepsRes, ingRes] = await Promise.all([
    db.collection('recipes').where({ recipeId }).limit(1).get(),
    db.collection('recipe_versions').where({ versionId: revision.versionId }).limit(1).get(),
    db.collection('recipe_steps').where({ versionId: revision.versionId }).get(),
    db.collection('recipe_ingredients').where({ versionId: revision.versionId }).get(),
  ])
  const recipe = recipeRes.data[0]
  const version = versionRes.data[0]
  if (!recipe || !version) return null

  // recipeSnapshot.media 已带 assetId→cloudFileId 映射（publisher 入库时写入）
  const media = (version.recipeSnapshot && version.recipeSnapshot.media) || []
  const assetToFileId = {}
  for (const m of media) assetToFileId[m.assetId] = m.cloudFileId

  const steps = stepsRes.data.sort((a, b) => a.stepNo - b.stepNo)
  const ingredients = ingRes.data.sort((a, b) => (a.sortKey || 0) - (b.sortKey || 0))

  const coverFileId = assetToFileId[recipe.coverAssetId] || (media.find((m) => m.role === 'cover') || {}).cloudFileId
  const stepFileIds = steps.map((s) => assetToFileId[(s.imageAssetIds || [])[0]]).filter(Boolean)
  const urlMap = await resolveUrls([coverFileId, ...stepFileIds])

  return {
    tutorialId: tutorial.tutorialId,
    recipeId,
    versionId: revision.versionId,
    name: recipe.name,
    coverUrl: urlMap[coverFileId] || '',
    summary: (version.recipeSnapshot && version.recipeSnapshot.summary) || '',
    difficulty: recipe.difficulty || 'unknown',
    totalDurationSeconds: recipe.totalDurationSeconds || null,
    servings: recipe.servings || null,
    cuisineTags: recipe.cuisineTags || [],
    ownerType: tutorial.ownerType,
    visibility: tutorial.visibility,
    source: {
      platform: tutorial.platform,
      url: tutorial.sourceUrl,
      bvid: tutorial.bvid,
      title: tutorial.sourceTitle || '',
    },
    ingredients: ingredients.map((it) => ({
      name: it.canonicalName || it.rawName || it.ingredientRef,
      amountText: it.amountText || (it.amount != null ? `${it.amount}${it.unit || ''}` : ''),
      role: it.role || 'required',
      optional: !!it.isOptional,
    })),
    steps: steps.map((s) => ({
      stepNo: s.stepNo,
      desc: s.instruction,
      imageUrl: urlMap[assetToFileId[(s.imageAssetIds || [])[0]]] || '',
      durationSeconds: s.durationSeconds || null,
    })),
  }
}

// ——— actions ———
async function listPublic(limit) {
  const res = await db.collection('tutorials')
    .where({ visibility: 'PUBLIC', lifecycleStatus: 'PUBLISHED' })
    .orderBy('publishedAt', 'desc')
    .limit(Math.min(Math.max(Number(limit) || 30, 1), 50))
    .get()
  const items = await Promise.all(res.data.map((t) => assembleRecipe(t)))
  return items.filter(Boolean)
}

async function listMine(openid) {
  const res = await db.collection('tutorials')
    .where({ ownerType: 'USER', ownerId: openid })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()
  // 列表只回摘要，避免每条都换 URL
  return res.data.map((t) => ({
    tutorialId: t.tutorialId,
    bvid: t.bvid,
    sourceTitle: t.sourceTitle || t.bvid,
    lifecycleStatus: t.lifecycleStatus,
    visibility: t.visibility,
    currentVersionId: t.currentVersionId,
    updatedAt: t.updatedAt,
  }))
}

async function detail(openid, tutorialId) {
  const res = await db.collection('tutorials').where({ tutorialId }).limit(1).get()
  const tutorial = res.data[0]
  if (!tutorial) throw new Error('未找到教程')
  // 私有教程只有所有者本人可看
  if (tutorial.visibility === 'PRIVATE' && tutorial.ownerId !== openid) throw new Error('无权访问该教程')
  return assembleRecipe(tutorial)
}

// 用户挑帧：返回自有教程的候选帧（带临时 URL），供小程序渲染选择。
async function getDraft(openid, tutorialId) {
  const res = await db.collection('tutorials').where({ tutorialId }).limit(1).get()
  const tutorial = res.data[0]
  if (!tutorial) throw new Error('未找到教程')
  if (tutorial.ownerType !== 'USER' || tutorial.ownerId !== openid) throw new Error('只能查看自己上传的教程草稿')
  const draftRes = await db.collection('tutorial_frame_drafts').where({ tutorialId }).limit(1).get()
  const draft = draftRes.data[0]
  if (!draft) throw new Error('尚无待挑帧草稿')
  const fileIds = (draft.steps || []).flatMap((s) => (s.candidates || []).map((c) => c.cloudFileId))
  const urlMap = await resolveUrls(fileIds)
  return {
    tutorialId,
    lifecycleStatus: tutorial.lifecycleStatus,
    recipeName: draft.recipeName || tutorial.sourceTitle || '',
    steps: (draft.steps || []).map((s) => ({
      stepIndex: s.stepIndex,
      name: s.name,
      description: s.description,
      candidates: (s.candidates || []).map((c) => ({ frameType: c.frameType, slot: c.slot, url: urlMap[c.cloudFileId] || '' })),
    })),
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: -1, msg: 'missing openid' }
  const { action } = event || {}
  try {
    switch (action) {
      // —— 读 ——
      case 'listPublic': return { code: 0, data: await listPublic(event.limit) }
      case 'listMine': return { code: 0, data: await listMine(OPENID) }
      case 'detail': return { code: 0, data: await detail(OPENID, event.tutorialId) }
      case 'getDraft': return { code: 0, data: await getDraft(OPENID, event.tutorialId) }
      // —— 治理写（代理到控制面）——
      case 'submit':
        return { code: 0, data: await callControlPlane('POST', '/v1/tutorials/bilibili', OPENID, { bvid: event.bvid, ownerType: 'USER', ownerId: OPENID }) }
      case 'submitFrameSelection':
        return { code: 0, data: await callControlPlane('POST', `/v1/tutorials/${encodeURIComponent(event.tutorialId)}/frame-selection`, OPENID, { selections: event.selections }) }
      case 'review':
        return { code: 0, data: await callControlPlane('POST', `/v1/tutorials/${encodeURIComponent(event.tutorialId)}/review`, OPENID, { action: event.reviewAction, versionId: event.versionId, reason: event.reason }) }
      case 'requestUpdate':
        return { code: 0, data: await callControlPlane('POST', `/v1/tutorials/${encodeURIComponent(event.tutorialId)}/updates`, OPENID, { changeSummary: event.changeSummary, visibility: event.visibility }) }
      default:
        return { code: -2, msg: `unknown action: ${action}` }
    }
  } catch (err) {
    console.error('[tutorials] failed', action, err)
    return { code: -1, msg: err.message || 'tutorials failed' }
  }
}

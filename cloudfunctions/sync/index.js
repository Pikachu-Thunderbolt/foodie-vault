// cloudfunctions/sync/index.js
// 通用同步云函数。
// actions:
//   firstUpload { payload }                       首次本地→云端迁移
//   pull        { since }                         增量拉取（按 updatedAt）
//   upsert      { collection, item }              单条写入（支持 _id 幂等）
//   delete      { collection, id }                单条删除
//   updatePrefs { preferences }                   写入 users 的偏好子字段

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COL = {
  ingredient_batches: 'ingredient_batches',
  ingredient_masters: 'ingredient_masters',
  inventory_transactions: 'ingredient_transactions',
  cooking_sessions: 'cooking_sessions',
  cooking_attempts: 'cooking_attempts',
  signature_dishes: 'signature_dishes',
  pantry_product_profiles: 'pantry_product_profiles',
  checklists: 'checklists',
  users: 'users',
}

// -------- firstUpload --------
async function firstUpload(openid, payload) {
  const results = {}
  const now = new Date()
  for (const key of Object.keys(payload || {})) {
    const items = payload[key]
    if (!items) continue

    // 用户偏好合并到 users 文档，不另起集合
    if (key === 'userPreferences') {
      await db.collection('users').where({ _openid: openid }).update({
        data: { ...items, updatedAt: now },
      })
      results[key] = 'merged'
      continue
    }
    if (!Array.isArray(items) || !items.length) continue

    const colName = COL[key]
    if (!colName) {
      results[key] = 'skipped(unknown)'
      continue
    }
    const col = db.collection(colName)
    let added = 0
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      try {
        await col.add({
          data: {
            ...it,
            _openid: openid,
            updatedAt: now,
            // 业务主键去重：用 _id 的话允许覆盖
          },
        })
        added += 1
      } catch (e) {
        console.warn(`[sync.firstUpload] add ${colName} 失败`, e.message)
      }
    }
    results[key] = `added ${added}/${items.length}`
  }
  return results
}

// -------- pull（按 updatedAt 增量） --------
async function pull(openid, since) {
  const sinceDate = since ? new Date(Number(since) || since) : new Date(0)
  const out = {}
  for (const [key, colName] of Object.entries(COL)) {
    const res = await db
      .collection(colName)
      .where({ _openid: openid, updatedAt: _.gte(sinceDate) })
      .limit(500)
      .get()
    out[key] = res.data
  }
  return out
}

// -------- upsert --------
async function upsertOne(openid, colName, item) {
  if (!COL[colName]) throw new Error(`unknown collection: ${colName}`)
  const col = db.collection(colName)
  const now = new Date()
  const data = { ...item, _openid: openid, updatedAt: now }
  if (item._id) {
    const id = item._id
    delete data._id
    try {
      await col.doc(id).set({ data })
      return { _id: id, mode: 'updated' }
    } catch (e) {
      const r = await col.add({ data })
      return { _id: r._id, mode: 'created' }
    }
  }
  const r = await col.add({ data })
  return { _id: r._id, mode: 'created' }
}

// -------- delete --------
async function deleteOne(openid, colName, id) {
  if (!COL[colName]) throw new Error(`unknown collection: ${colName}`)
  await db.collection(colName).where({ _openid: openid, _id: id }).remove()
  return { _id: id, mode: 'deleted' }
}

// -------- updatePrefs（写入 users 子字段） --------
async function updatePrefs(openid, preferences) {
  const now = new Date()
  const r = await db
    .collection('users')
    .where({ _openid: openid })
    .update({ data: { ...preferences, updatedAt: now } })
  return { updated: r.updated }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: -1, msg: 'missing openid' }
  const { action, payload, since } = event || {}

  try {
    if (action === 'firstUpload') return { code: 0, data: await firstUpload(OPENID, payload || {}) }
    if (action === 'pull') return { code: 0, data: await pull(OPENID, since) }
    if (action === 'upsert') {
      return { code: 0, data: await upsertOne(OPENID, payload.collection, payload.item) }
    }
    if (action === 'delete') {
      return { code: 0, data: await deleteOne(OPENID, payload.collection, payload.id) }
    }
    if (action === 'updatePrefs') {
      return { code: 0, data: await updatePrefs(OPENID, payload || {}) }
    }
    return { code: -2, msg: `unknown action: ${action}` }
  } catch (err) {
    console.error('[sync] failed', action, err)
    return { code: -1, msg: err.message || 'sync failed' }
  }
}

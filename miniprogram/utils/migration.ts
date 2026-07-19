// utils/migration.ts
// 首次本地→云端迁移。
// 触发条件：本地存在业务数据 + 未设置 _migrated_v1 标志。

import { callFn } from './cloud'

const FLAG = '_migrated_v1'

interface IMigrationPayload {
  ingredients: unknown[]
  ingredient_masters: unknown[]
  inventory_transactions: unknown[]
  cooking_sessions: unknown[]
  cooking_attempts: unknown[]
  signature_dishes: unknown[]
  pantry_product_profiles: unknown[]
  checklists: unknown[]
  userPreferences: Record<string, unknown> | null
}

function snapshotLocal(): IMigrationPayload {
  return {
    ingredients: wx.getStorageSync('ingredients') || [],
    ingredient_masters: wx.getStorageSync('ingredient_masters') || [],
    inventory_transactions: wx.getStorageSync('ingredient_transactions') || [],
    cooking_sessions: wx.getStorageSync('cooking_sessions') || [],
    cooking_attempts: wx.getStorageSync('cooking_attempts') || [],
    signature_dishes: wx.getStorageSync('signature_dishes') || [],
    pantry_product_profiles: wx.getStorageSync('pantry_product_profiles') || [],
    checklists: wx.getStorageSync('shoppingChecklist') || [],
    userPreferences: wx.getStorageSync('userPreferences') || null,
  }
}

function countTotal(p: IMigrationPayload): number {
  return (
    p.ingredients.length +
    p.ingredient_masters.length +
    p.inventory_transactions.length +
    p.cooking_sessions.length +
    p.cooking_attempts.length +
    p.signature_dishes.length +
    p.pantry_product_profiles.length +
    p.checklists.length +
    (p.userPreferences ? 1 : 0)
  )
}

export async function runFirstMigration(): Promise<void> {
  if (wx.getStorageSync(FLAG)) return
  const snap = snapshotLocal()
  const total = countTotal(snap)
  if (total === 0) {
    wx.setStorageSync(FLAG, Date.now())
    return
  }
  try {
    await callFn('sync', { action: 'firstUpload', payload: snap })
    wx.setStorageSync(FLAG, Date.now())
    console.log('[migration] 首次上传完成，共', total, '条')
  } catch (err) {
    console.warn('[migration] 上传失败，下次启动自动重试', err)
  }
}

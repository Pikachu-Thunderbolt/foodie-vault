// utils/sync.ts
// 增量拉取云端数据，覆盖本地 cache。云端为权威。

import { callFn } from './cloud'

const LAST_KEY = '_last_sync_at'

// 与 utils/storage.ts 中本地 storage key 一一对应
const KEYS: Array<{ cloud: string; local: string }> = [
  { cloud: 'ingredient_batches', local: 'ingredients' },
  { cloud: 'ingredient_masters', local: 'ingredient_masters' },
  { cloud: 'inventory_transactions', local: 'ingredient_transactions' },
  { cloud: 'cooking_sessions', local: 'cooking_sessions' },
  { cloud: 'cooking_attempts', local: 'cooking_attempts' },
  { cloud: 'signature_dishes', local: 'signature_dishes' },
  { cloud: 'pantry_product_profiles', local: 'pantry_product_profiles' },
  { cloud: 'checklists', local: 'shoppingChecklist' },
]

export async function pullSync(): Promise<void> {
  const since = wx.getStorageSync(LAST_KEY) || 0
  try {
    const data = (await callFn<Record<string, unknown>>('sync', {
      action: 'pull',
      since,
    })) || {}
    for (const { cloud, local } of KEYS) {
      if (Array.isArray(data[cloud])) {
        wx.setStorageSync(local, data[cloud])
      }
    }
    wx.setStorageSync(LAST_KEY, Date.now())
  } catch (err) {
    console.warn('[sync] pull 失败，沿用本地', err)
  }
}

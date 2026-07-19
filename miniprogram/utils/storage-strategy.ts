// utils/storage-strategy.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 数据分层策略（必读）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 三层职责，禁止互相越权：
//
//   【Cloud · 云数据库 / 权威】
//     - 用户身份 (openid/nickname/avatarUrl/gender)
//     - 用户偏好 (tastePreference/dietaryRestrictions/...)
//     - 食材批次/主档、库存流水、做菜会话/记录、拿手菜、购物清单
//     - 公共数据 (recipes / food_dictionary)
//   ──► 由 wx.cloud.callFunction / cloud database 访问
//   ──► 任何 _openid 字段自动由服务端注入，**前端不要伪造**
//
//   【Server · 云函数 / 处理】
//     - 登录鉴权、首次迁移、增量同步、单条 upsert/delete
//     - 图像/条码识别 (Phase 2)
//     - 推荐算法、推送 (Phase 3/4)
//     - 拿手菜分享海报生成
//   ──► 仅 cloud function 内部读写，不直接面向前端做 CRUD
//
//   【Local · 终端 storage / 缓存】
//     - 用户档案 cache (_user_cache)：与 users 集合镜像
//     - openid cache (_openid_cache)
//     - 同步队列 (_sync_queue_v1)
//     - 表单草稿、未提交扫描结果
//     - 首次迁移标志 (_migrated_v1) + 上次同步时间 (_last_sync_at)
//   ──► 仅供离线/弱网 fallback；永远以云端为准
//
//  ┌─────────────────────────────────────────────────────────┐
//  │ 修改规则：                                               │
//  │ ① 写入：先写本地（UI 立即可用）→ 异步入云                │
//  │ ② 读取：本地优先 → 后台静默拉新                          │
//  │ ③ 冲突：以 updatedAt 较新者为准（云端作为最终权威）      │
//  └─────────────────────────────────────────────────────────┘

export type StorageLayer = 'cloud' | 'local' | 'server'

export interface IStorageStrategyEntry {
  layer: StorageLayer
  /** 云数据库集合名；null = 不在云端 */
  collection: string | null
  /** 多用户隔离字段；null = 公共数据 */
  ownerField: '_openid' | null
  note: string
}

export const STORAGE_STRATEGY: Record<string, IStorageStrategyEntry> = {
  // —— 云端：用户私有 ——
  userIdentity: {
    layer: 'cloud',
    collection: 'users',
    ownerField: '_openid',
    note: 'openid、nickname、avatarUrl、gender；多用户隔离的唯一标识。',
  },
  userPreferences: {
    layer: 'cloud',
    collection: 'users',
    ownerField: '_openid',
    note: '与 userIdentity 同集合同一文档；口味/忌口/难度/提醒天数/主题风格。',
  },
  ingredientMasters: {
    layer: 'cloud',
    collection: 'ingredient_masters',
    ownerField: '_openid',
    note: '同名食材聚合字典（番茄=西红柿）；每用户独立。',
  },
  ingredientBatches: {
    layer: 'cloud',
    collection: 'ingredient_batches',
    ownerField: '_openid',
    note: '库存批次；本地仅做 mirror，断网时仍可读写。',
  },
  inventoryTransactions: {
    layer: 'cloud',
    collection: 'inventory_transactions',
    ownerField: '_openid',
    note: '消耗/过期/做菜流水。只增不改，用于追溯浪费来源。',
  },
  cookingSessions: {
    layer: 'cloud',
    collection: 'cooking_sessions',
    ownerField: '_openid',
    note: '做菜会话，preparing → completed/cancelled。',
  },
  cookingAttempts: {
    layer: 'cloud',
    collection: 'cooking_attempts',
    ownerField: '_openid',
    note: '每次下厨记录（评分、笔记、改动、客人），拿手菜的数据源。',
  },
  signatureDishes: {
    layer: 'cloud',
    collection: 'signature_dishes',
    ownerField: '_openid',
    note: '拿手菜聚合视图，由 cookingAttempts 派生。',
  },
  pantryProductProfiles: {
    layer: 'cloud',
    collection: 'pantry_product_profiles',
    ownerField: '_openid',
    note: '用户用量学习（同品牌同规格同食材的历史餐份）。',
  },
  checklists: {
    layer: 'cloud',
    collection: 'checklists',
    ownerField: '_openid',
    note: '购物清单项。',
  },

  // —— 云端：公共（运营写、所有用户读） ——
  recipes: {
    layer: 'cloud',
    collection: 'recipes',
    ownerField: null,
    note: '菜谱库。Phase 4 上线后由 sync 云函数提供 listOfficial / recommend。',
  },
  foodDictionary: {
    layer: 'cloud',
    collection: 'food_dictionary',
    ownerField: null,
    note: '服务端食材词典（canonicalName/category/defaultExpiryDays）。',
  },
  subscribeLogs: {
    layer: 'cloud',
    collection: 'subscribe_logs',
    ownerField: '_openid',
    note: '推送记录防重复。Phase 3 上线。',
  },

  // —— 本地缓存（仅终端） ——
  userCache: {
    layer: 'local',
    collection: null,
    ownerField: null,
    note: '_user_cache：登录后从云端拉取的用户档案镜像。',
  },
  openidCache: {
    layer: 'local',
    collection: null,
    ownerField: null,
    note: '_openid_cache：避免每次启动都调用 login 云函数。',
  },
  syncQueue: {
    layer: 'local',
    collection: null,
    ownerField: null,
    note: '_sync_queue_v1：未上传的写操作队列，断网时排队，恢复后自动重试。',
  },
  drafts: {
    layer: 'local',
    collection: null,
    ownerField: null,
    note: '表单草稿 / 未确认的扫描结果。不上传，避免污染云端数据。',
  },
  lastSyncAt: {
    layer: 'local',
    collection: null,
    ownerField: null,
    note: '_last_sync_at：上次拉取同步的时间戳。',
  },
  migrationFlag: {
    layer: 'local',
    collection: null,
    ownerField: null,
    note: '_migrated_v1：首次迁移完成标志，避免重复迁移。',
  },

  // —— Server 处理 ——
  recognitionCache: {
    layer: 'server',
    collection: null,
    ownerField: null,
    note: '图像/条码识别结果缓存，由 scanner 云函数维护（Phase 2）。',
  },
}

export const STORAGE_LAYER_DESC = {
  cloud: '云端（cloud database）：用户私有 / 公共数据，云端为权威。',
  local: '终端（wx.storage）：离线缓存 + 草稿 + 同步队列，仅本地。',
  server: 'Server（cloud function）：处理逻辑 + 转发 + 计算，不直接面向前端。',
} as const

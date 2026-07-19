// 食材存储：主档（用于选材与匹配）+ 库存批次（用于品牌、数量、保质期）。

export interface IIngredientMaster {
  id: string
  canonicalName: string
  category: string
  defaultUnit: string
  trackingMode: IngredientTrackingMode
  aliases: string[]
  createdAt: string
  updatedAt: string
}

export type IngredientTrackingMode = 'exact' | 'estimated' | 'level' | 'presence'
export type PantryLevel = 'full' | 'sufficient' | 'half' | 'low' | 'empty'
export type ConsumptionReason = 'quick_use' | 'expired' | 'discard' | 'adjustment' | 'cook'

export interface IInventoryTransaction {
  id: string
  type: ConsumptionReason
  occurredAt: string
  masterId: string
  canonicalName: string
  allocations: { batchId: string; quantity: number; unit: string }[]
  amountText?: string
  recipeId?: string
  cookingSessionId?: string
  note?: string
}

export interface ICookingSession {
  id: string
  recipeId: string
  recipeName: string
  state: 'preparing' | 'completed' | 'cancelled'
  reservations: { batchId: string; quantity: number; unit: string }[]
  createdAt: string
  completedAt?: string
  transactionIds: string[]
}

export interface IPantryProductProfile {
  id: string
  masterId: string
  canonicalName: string
  brand: string
  variant: string
  packageSize: string
  useCount: number
  totalServingUnits: number
  averageServingUnits: number
  typicalServingsPerPackage?: number
  confidence: 'low' | 'medium' | 'high'
  updatedAt: string
}

export interface IIngredient {
  // id 是具体库存批次 ID；同一 canonicalName 可有多条批次记录。
  id: string
  masterId: string
  canonicalName: string
  name: string
  brand?: string
  variant?: string
  packageSize?: string
  category: string
  purchaseDate: string
  expiryDate: string
  quantity: number
  unit: string
  storageLocation: string
  status: 'fresh' | 'expiring' | 'expired'
  imageUrl?: string
  notes?: string
  trackingMode?: IngredientTrackingMode
  pantryLevel?: PantryLevel
  estimatedServings?: number
  servingSize?: number
  matchConfidence?: number
  matchSource?: FoodMatchSource
}

export type IIngredientBatch = IIngredient
export type IIngredientBatchInput = Omit<IIngredient, 'id' | 'masterId' | 'canonicalName' | 'status'> & {
  canonicalName?: string
}

export interface IIngredientGroup extends IIngredient {
  batchCount: number
  quantityDisplay: string
  batchSummary: string
}

const STORAGE_KEY = 'ingredients'
const MASTER_STORAGE_KEY = 'ingredient_masters'
const TRANSACTION_STORAGE_KEY = 'ingredient_transactions'
const COOKING_SESSION_STORAGE_KEY = 'cooking_sessions'
const PANTRY_PROFILE_STORAGE_KEY = 'pantry_product_profiles'

export type FoodMatchSource = 'exact' | 'alias' | 'normalized' | 'fuzzy' | 'fallback'

export interface FoodMatchResult {
  rawName: string
  normalizedName: string
  canonicalName?: string
  confidence: number
  source: FoodMatchSource
}

interface FoodDictionaryEntry {
  canonicalName: string
  category: string
  aliases: string[]
}

// 这是本地第一层词典。后续可由服务端词典下发覆盖，保证识图、手输和库存迁移使用相同 ID。
const FOOD_DICTIONARY: FoodDictionaryEntry[] = [
  { canonicalName: '番茄', category: '蔬菜', aliases: ['西红柿', '圣女果', '小番茄', 'fanqie'] },
  { canonicalName: '鸡蛋', category: '蛋奶', aliases: ['草鸡蛋', '无菌鸡蛋', '土鸡蛋', '鲜鸡蛋', 'jidan'] },
  { canonicalName: '牛奶', category: '蛋奶', aliases: ['全脂牛奶', '低脂牛奶', '脱脂牛奶', '鲜牛奶', '纯牛奶', 'xian niunai', 'niunai'] },
  { canonicalName: '酸奶', category: '蛋奶', aliases: ['原味酸奶', '无糖酸奶', '希腊酸奶', 'yogurt', 'suannai'] },
  { canonicalName: '西兰花', category: '蔬菜', aliases: ['西蓝花', '绿花椰菜', 'xilanhua'] },
  { canonicalName: '花菜', category: '蔬菜', aliases: ['菜花', '白花菜', 'cauliflower'] },
  { canonicalName: '上海青', category: '蔬菜', aliases: ['青菜', '青江菜', '小白菜', 'shanghaqing'] },
  { canonicalName: '大白菜', category: '蔬菜', aliases: ['白菜', '黄芽白', '娃娃菜', 'dabaicai'] },
  { canonicalName: '白萝卜', category: '蔬菜', aliases: ['萝卜', '白萝卜条', 'bailuobo'] },
  { canonicalName: '土豆', category: '蔬菜', aliases: ['马铃薯', '洋芋', 'tudou'] },
  { canonicalName: '黄瓜', category: '蔬菜', aliases: ['青瓜', 'huanggua'] },
  { canonicalName: '洋葱', category: '蔬菜', aliases: ['圆葱', '洋葱头', 'yangcong'] },
  { canonicalName: '胡萝卜', category: '蔬菜', aliases: ['红萝卜', 'huluobo'] },
  { canonicalName: '冬瓜', category: '蔬菜', aliases: ['donggua'] },
  { canonicalName: '生菜', category: '蔬菜', aliases: ['球生菜', '罗马生菜', 'shengcai'] },
  { canonicalName: '菠菜', category: '蔬菜', aliases: ['bocai'] },
  { canonicalName: '青椒', category: '蔬菜', aliases: ['尖椒', '辣椒', 'qingjiao'] },
  { canonicalName: '鸡肉', category: '肉类', aliases: ['鸡胸肉', '鸡腿肉', '鸡腿', '鸡翅', '去皮鸡肉', 'jixiongrou'] },
  { canonicalName: '猪肉', category: '肉类', aliases: ['猪肉馅', '五花肉', '猪里脊', '梅花肉', 'zhurou'] },
  { canonicalName: '虾', category: '水产', aliases: ['虾仁', '大虾', '去皮虾仁', '冷冻虾仁', 'xiaren'] },
  { canonicalName: '三文鱼', category: '水产', aliases: ['三文鱼块', 'salmon', 'sanwenyu'] },
  { canonicalName: '牛油果', category: '水果', aliases: ['鳄梨', 'avocado', 'niuyouguo'] },
  { canonicalName: '豆腐', category: '豆制品', aliases: ['嫩豆腐', '老豆腐', '内酯豆腐', 'doufu'] },
  { canonicalName: '奶酪', category: '蛋奶', aliases: ['芝士', '芝士片', 'cheese'] },
  { canonicalName: '食盐', category: '调料', aliases: ['盐', '食用盐', 'shiyan'] },
]

const STRIP_TOKENS = /(?:[\d.]+(?:g|kg|克|千克|ml|l|毫升|升|斤|袋|盒|瓶|包|个|支|片|份|x|×)|(?:盒马|山姆|叮咚|有机|新鲜|精选|特级|冷冻|冷藏|常温|散装|袋装|盒装|去皮|去骨|切块|切片|整只|国产|进口|低脂|脱脂|全脂|原味|无糖|鲜))/gi

function normalizeFoodName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/（）()【】\[\]·]/g, '')
    .replace(STRIP_TOKENS, '')
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column]
  }
  return previous[right.length]
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.88
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length)
}

export function resolveFoodMatch(name: string): FoodMatchResult {
  const rawName = String(name || '').trim()
  const normalizedName = normalizeFoodName(rawName)
  if (!normalizedName) return { rawName, normalizedName, confidence: 0, source: 'fallback' }
  for (const item of FOOD_DICTIONARY) {
    if (normalizedName === normalizeFoodName(item.canonicalName)) return { rawName, normalizedName, canonicalName: item.canonicalName, confidence: 1, source: 'exact' }
    if (item.aliases.some((alias) => normalizedName === normalizeFoodName(alias))) return { rawName, normalizedName, canonicalName: item.canonicalName, confidence: 0.98, source: 'alias' }
  }
  let best: FoodMatchResult = { rawName, normalizedName, confidence: 0, source: 'fallback' }
  for (const item of FOOD_DICTIONARY) {
    for (const candidate of [item.canonicalName, ...item.aliases]) {
      const score = similarity(normalizedName, normalizeFoodName(candidate))
      if (score > best.confidence) best = { rawName, normalizedName, canonicalName: item.canonicalName, confidence: score, source: 'fuzzy' }
    }
  }
  return best.confidence >= 0.82 ? best : { rawName, normalizedName, confidence: best.confidence, source: 'fallback' }
}

function todayString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function resolveCanonicalName(name: string): string {
  const result = resolveFoodMatch(name)
  return result.canonicalName || result.normalizedName
}

function masterIdOf(canonicalName: string): string {
  return `master_${encodeURIComponent(canonicalName)}`
}

function calcStatus(expiryDate: string): IIngredient['status'] {
  const diffDays = Math.ceil((new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diffDays < 0) return 'expired'
  if (diffDays <= 3) return 'expiring'
  return 'fresh'
}

function generateId(): string {
  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
}

const LEVEL_LABELS: Record<PantryLevel, string> = { full: '满', sufficient: '充足', half: '过半', low: '将尽', empty: '空' }

export function getPantryLevelLabel(level?: PantryLevel): string {
  return level ? LEVEL_LABELS[level] : ''
}

export function inferTrackingMode(name: string): IngredientTrackingMode {
  const canonicalName = resolveCanonicalName(name)
  if (/^(盐|糖|酱油|醋|料酒|蚝油|香油|胡椒|花椒|淀粉|香料)/.test(canonicalName)) return 'presence'
  if (/^(大米|小米|面粉|食用油|橄榄油|挂面|杂粮|燕麦)/.test(canonicalName)) return 'estimated'
  return 'exact'
}

function migrateBatch(raw: Partial<IIngredient>): IIngredient {
  const name = String(raw.name || raw.canonicalName || '').trim()
  const match = resolveFoodMatch(raw.canonicalName || name)
  const canonicalName = match.canonicalName || match.normalizedName
  return {
    id: raw.id || generateId(),
    masterId: raw.masterId || masterIdOf(canonicalName),
    canonicalName,
    name: name || canonicalName,
    brand: raw.brand?.trim(),
    variant: raw.variant?.trim(),
    packageSize: raw.packageSize?.trim(),
    category: raw.category || '冷藏',
    purchaseDate: raw.purchaseDate || todayString(),
    expiryDate: raw.expiryDate || todayString(),
    // 0 是有效库存值：已用完的批次仍需保留，用于流水追溯与避免迁移时“复活”。
    quantity: Number.isFinite(Number(raw.quantity)) ? Math.max(0, Number(raw.quantity)) : 1,
    unit: raw.unit || '个',
    storageLocation: raw.storageLocation || '',
    status: calcStatus(raw.expiryDate || todayString()),
    imageUrl: raw.imageUrl,
    notes: raw.notes,
    trackingMode: raw.trackingMode || inferTrackingMode(canonicalName),
    pantryLevel: raw.pantryLevel || (inferTrackingMode(canonicalName) === 'estimated' ? 'full' : undefined),
    estimatedServings: raw.estimatedServings,
    servingSize: raw.servingSize,
    matchConfidence: raw.matchConfidence ?? match.confidence,
    matchSource: raw.matchSource || match.source,
  }
}

function saveMastersFromBatches(batches: IIngredient[]): void {
  const oldMasters = (wx.getStorageSync(MASTER_STORAGE_KEY) || []) as IIngredientMaster[]
  const oldById = new Map(oldMasters.map((item) => [item.id, item]))
  const now = todayString()
  const masters = Array.from(new Map(batches.map((batch) => [batch.masterId, batch])).values()).map((batch) => {
    const previous = oldById.get(batch.masterId)
    return {
      id: batch.masterId,
      canonicalName: batch.canonicalName,
      category: batch.category,
      defaultUnit: batch.unit,
      trackingMode: batch.trackingMode || inferTrackingMode(batch.canonicalName),
      aliases: Array.from(new Set([batch.canonicalName, batch.name, ...(previous?.aliases || [])].filter(Boolean))),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    }
  })
  wx.setStorageSync(MASTER_STORAGE_KEY, masters)
}

// 获取所有批次；旧数据会在首次读取时补齐 canonicalName/masterId，不丢失现有库存。
export function getAllIngredients(): IIngredientBatch[] {
  const raw = (wx.getStorageSync(STORAGE_KEY) || []) as Partial<IIngredient>[]
  const batches = raw.map(migrateBatch)
  const changed = JSON.stringify(raw) !== JSON.stringify(batches)
  if (changed) wx.setStorageSync(STORAGE_KEY, batches)
  saveMastersFromBatches(batches)
  return batches
}

export function getIngredientMasters(): IIngredientMaster[] {
  const batches = getAllIngredients()
  const masters = (wx.getStorageSync(MASTER_STORAGE_KEY) || []) as IIngredientMaster[]
  return masters.filter((master) => batches.some((batch) => batch.masterId === master.id))
}

export function getIngredientBatches(masterId: string): IIngredientBatch[] {
  return getAllIngredients().filter((batch) => batch.masterId === masterId)
}

// 首页使用主档聚合视图；实际编辑、临期和消耗仍基于具体库存批次。
export function getIngredientGroups(): IIngredientGroup[] {
  const groups = new Map<string, IIngredientBatch[]>()
  getAllIngredients().filter((batch) => batch.quantity > 0).forEach((batch) => {
    const group = groups.get(batch.masterId) || []
    group.push(batch)
    groups.set(batch.masterId, group)
  })
  return Array.from(groups.entries()).map(([masterId, batches]) => {
    const sorted = [...batches].sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())
    const representative = sorted.find((batch) => batch.status !== 'expired') || sorted[0]
    const units = Array.from(new Set(batches.map((batch) => batch.unit)))
    const quantityDisplay = units.length === 1
      ? `${batches.reduce((sum, batch) => sum + batch.quantity, 0)}${units[0]}`
      : `${batches.length} 批`
    const batchSummary = batches.length > 1
      ? `${batches.length} 批次 · 最早 ${representative.expiryDate} 到期`
      : [representative.brand, representative.variant].filter(Boolean).join(' · ')
    return {
      ...representative,
      id: masterId,
      masterId,
      name: representative.canonicalName,
      canonicalName: representative.canonicalName,
      quantity: batches.reduce((sum, batch) => sum + batch.quantity, 0),
      unit: units.length === 1 ? units[0] : '批',
      batchCount: batches.length,
      quantityDisplay,
      batchSummary,
    }
  })
}

export function addIngredient(input: IIngredientBatchInput): IIngredientBatch {
  const canonicalName = resolveCanonicalName(input.canonicalName || input.name)
  const batch: IIngredientBatch = {
    ...input,
    id: generateId(),
    masterId: masterIdOf(canonicalName),
    canonicalName,
    name: input.name.trim() || canonicalName,
    brand: input.brand?.trim(),
    variant: input.variant?.trim(),
    packageSize: input.packageSize?.trim(),
    status: calcStatus(input.expiryDate),
    trackingMode: input.trackingMode || inferTrackingMode(canonicalName),
    pantryLevel: input.pantryLevel || (inferTrackingMode(canonicalName) === 'estimated' ? 'full' : undefined),
  }
  const batches = getAllIngredients()
  batches.unshift(batch)
  wx.setStorageSync(STORAGE_KEY, batches)
  saveMastersFromBatches(batches)
  return batch
}

function saveTransactions(transactions: IInventoryTransaction[]): void { wx.setStorageSync(TRANSACTION_STORAGE_KEY, transactions) }
export function getInventoryTransactions(): IInventoryTransaction[] { return (wx.getStorageSync(TRANSACTION_STORAGE_KEY) || []) as IInventoryTransaction[] }
export function getCookingSessions(): ICookingSession[] { return (wx.getStorageSync(COOKING_SESSION_STORAGE_KEY) || []) as ICookingSession[] }

// 单次减少默认按 FEFO 分配；无论入口来自做菜、过期还是随手用掉，都写入同一账本。
export function consumeIngredient(masterId: string, quantity: number, type: ConsumptionReason, options: { amountText?: string; recipeId?: string; cookingSessionId?: string; note?: string } = {}): IInventoryTransaction | null {
  if (quantity <= 0) return null
  const batches = getAllIngredients()
  const candidates = batches.filter((batch) => batch.masterId === masterId && batch.quantity > 0).sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())
  if (!candidates.length) return null
  let remaining = quantity
  const allocations: IInventoryTransaction['allocations'] = []
  for (const batch of candidates) {
    if (remaining <= 0) break
    const used = Math.min(batch.quantity, remaining)
    batch.quantity -= used
    remaining -= used
    allocations.push({ batchId: batch.id, quantity: used, unit: batch.unit })
  }
  const consumed = quantity - remaining
  if (!consumed) return null
  wx.setStorageSync(STORAGE_KEY, batches)
  saveMastersFromBatches(batches)
  const first = candidates[0]
  const transaction: IInventoryTransaction = {
    id: `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type, occurredAt: new Date().toISOString(), masterId, canonicalName: first.canonicalName,
    allocations, amountText: options.amountText, recipeId: options.recipeId, cookingSessionId: options.cookingSessionId, note: options.note,
  }
  saveTransactions([transaction, ...getInventoryTransactions()])
  return transaction
}

export function updatePantryLevel(masterId: string, level: PantryLevel): boolean {
  const batches = getAllIngredients()
  let changed = false
  batches.forEach((batch) => { if (batch.masterId === masterId) { batch.pantryLevel = level; changed = true } })
  if (changed) { wx.setStorageSync(STORAGE_KEY, batches); saveMastersFromBatches(batches) }
  return changed
}

function profileIdFor(batch: Pick<IIngredient, 'masterId' | 'brand' | 'variant' | 'packageSize'>): string {
  return `profile_${encodeURIComponent([batch.masterId, batch.brand || '', batch.variant || '', batch.packageSize || ''].join('|'))}`
}

export function getPantryProductProfile(batch: Pick<IIngredient, 'masterId' | 'brand' | 'variant' | 'packageSize'>): IPantryProductProfile | null {
  const id = profileIdFor(batch)
  return ((wx.getStorageSync(PANTRY_PROFILE_STORAGE_KEY) || []) as IPantryProductProfile[]).find((profile) => profile.id === id) || null
}

// “少量/一餐/两餐”是主动反馈，不伪造克数；累计两次后才允许用户设置同包装的餐份预估。
export function recordEstimatedUsage(masterId: string, servingUnits: number): IPantryProductProfile | null {
  const batch = getAllIngredients().filter((item) => item.masterId === masterId && item.quantity > 0).sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0]
  if (!batch) return null
  const profiles = (wx.getStorageSync(PANTRY_PROFILE_STORAGE_KEY) || []) as IPantryProductProfile[]
  const id = profileIdFor(batch)
  const index = profiles.findIndex((profile) => profile.id === id)
  const previous = index >= 0 ? profiles[index] : null
  const useCount = (previous?.useCount || 0) + 1
  const totalServingUnits = (previous?.totalServingUnits || 0) + servingUnits
  const profile: IPantryProductProfile = {
    id, masterId, canonicalName: batch.canonicalName, brand: batch.brand || '', variant: batch.variant || '', packageSize: batch.packageSize || '',
    useCount, totalServingUnits, averageServingUnits: Math.round((totalServingUnits / useCount) * 10) / 10,
    typicalServingsPerPackage: previous?.typicalServingsPerPackage,
    confidence: useCount >= 5 ? 'high' : useCount >= 2 ? 'medium' : 'low', updatedAt: new Date().toISOString(),
  }
  if (index >= 0) profiles[index] = profile
  else profiles.unshift(profile)
  wx.setStorageSync(PANTRY_PROFILE_STORAGE_KEY, profiles)
  const level: PantryLevel = servingUnits >= 2 ? 'half' : 'sufficient'
  updatePantryLevel(masterId, level)
  return profile
}

export function setTypicalServingsPerPackage(masterId: string, total: number): IPantryProductProfile | null {
  if (!Number.isFinite(total) || total <= 0) return null
  const batch = getAllIngredients().find((item) => item.masterId === masterId && item.quantity > 0)
  if (!batch) return null
  const profiles = (wx.getStorageSync(PANTRY_PROFILE_STORAGE_KEY) || []) as IPantryProductProfile[]
  const id = profileIdFor(batch)
  const index = profiles.findIndex((profile) => profile.id === id)
  const current = index >= 0 ? profiles[index] : recordEstimatedUsage(masterId, 0)
  if (!current) return null
  const profile = { ...current, typicalServingsPerPackage: Math.round(total), updatedAt: new Date().toISOString() }
  const nextIndex = profiles.findIndex((item) => item.id === id)
  if (nextIndex >= 0) profiles[nextIndex] = profile
  else profiles.unshift(profile)
  wx.setStorageSync(PANTRY_PROFILE_STORAGE_KEY, profiles)
  return profile
}

export function createCookingSession(recipeId: string, recipeName: string, reservations: ICookingSession['reservations']): ICookingSession {
  const session: ICookingSession = { id: `cook_${Date.now().toString(36)}`, recipeId, recipeName, state: 'preparing', reservations, createdAt: new Date().toISOString(), transactionIds: [] }
  wx.setStorageSync(COOKING_SESSION_STORAGE_KEY, [session, ...getCookingSessions()])
  return session
}

export function completeCookingSession(id: string): ICookingSession | null {
  const sessions = getCookingSessions()
  const session = sessions.find((item) => item.id === id)
  if (!session || session.state !== 'preparing') return null
  const transactionIds: string[] = []
  const grouped = new Map<string, number>()
  session.reservations.forEach((reservation) => {
    const batch = getAllIngredients().find((item) => item.id === reservation.batchId)
    if (batch) grouped.set(batch.masterId, (grouped.get(batch.masterId) || 0) + reservation.quantity)
  })
  grouped.forEach((quantity, masterId) => { const tx = consumeIngredient(masterId, quantity, 'cook', { recipeId: session.recipeId, cookingSessionId: id }); if (tx) transactionIds.push(tx.id) })
  session.state = 'completed'; session.completedAt = new Date().toISOString(); session.transactionIds = transactionIds
  wx.setStorageSync(COOKING_SESSION_STORAGE_KEY, sessions)
  return session
}

export function updateIngredient(id: string, data: Partial<IIngredientBatchInput>): IIngredientBatch | null {
  const batches = getAllIngredients()
  const index = batches.findIndex((item) => item.id === id)
  if (index === -1) return null
  const current = batches[index]
  const canonicalName = resolveCanonicalName(data.canonicalName || data.name || current.canonicalName)
  batches[index] = {
    ...current,
    ...data,
    canonicalName,
    masterId: masterIdOf(canonicalName),
    name: (data.name || current.name).trim(),
    status: calcStatus(data.expiryDate || current.expiryDate),
  }
  wx.setStorageSync(STORAGE_KEY, batches)
  saveMastersFromBatches(batches)
  return batches[index]
}

export function deleteIngredient(id: string): boolean {
  const batches = getAllIngredients()
  const index = batches.findIndex((item) => item.id === id)
  if (index === -1) return false
  batches.splice(index, 1)
  wx.setStorageSync(STORAGE_KEY, batches)
  saveMastersFromBatches(batches)
  return true
}

export function getIngredientsByStatus(status: IIngredient['status']): IIngredientBatch[] {
  return getAllIngredients().filter((item) => item.status === status)
}

// 临期结果仍返回批次，供“先消耗哪一批”与详情页使用。
export function getExpiringIngredients(days = 3): IIngredientBatch[] {
  const now = Date.now()
  return getAllIngredients().filter((item) => item.quantity > 0 && (() => {
    const diffDays = Math.ceil((new Date(item.expiryDate).getTime() - now) / (1000 * 60 * 60 * 24))
    return diffDays >= 0 && diffDays <= days
  })())
}

export function getIngredientsByCategory(category: string): IIngredientBatch[] {
  return getAllIngredients().filter((item) => item.quantity > 0 && item.category === category)
}

// 选材和菜谱匹配只使用食材主档：同一类食材只出现一次。
export function getIngredientNames(): string[] {
  const seen = new Set<string>()
  return getAllIngredients()
    .filter((item) => item.status !== 'expired' && item.quantity > 0)
    .map((item) => item.canonicalName)
    .filter((name) => {
      if (!name || seen.has(name)) return false
      seen.add(name)
      return true
    })
}

export function getIngredientStats() {
  const all = getAllIngredients().filter((item) => item.quantity > 0)
  return {
    total: all.length,
    fresh: all.filter((item) => item.status === 'fresh').length,
    expiring: all.filter((item) => item.status === 'expiring').length,
    expired: all.filter((item) => item.status === 'expired').length,
  }
}

export function clearExpiredIngredients(): number {
  // 过期清理也需要进入流水；批次置零后保留，便于后续复盘浪费来源。
  const expired = getAllIngredients().filter((item) => item.status === 'expired' && item.quantity > 0)
  let handled = 0
  expired.forEach((batch) => {
    const tx = consumeIngredient(batch.masterId, batch.quantity, 'expired', { note: '集中清理过期食材' })
    if (tx) handled++
  })
  return handled
}

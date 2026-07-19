// 拿手菜数据层：一次制作是一条 CookingAttempt，同一道标准菜聚合为 SignatureDish。

export type SignatureDishStatus = 'practicing' | 'improving' | 'stable' | 'signature' | 'family-classic'

export interface ICookingAttempt {
  id: string
  recipeId: string
  recipeName: string
  cookedAt: string
  rating: number
  imageUrls: string[]
  note: string
  changeNote: string
  resultTags: string[]
  diners: string
  satisfied: boolean
  isMilestone: boolean
  milestoneTitle?: string
}

export interface ISignatureDish {
  id: string
  recipeId: string
  canonicalName: string
  personalName: string
  tagline: string
  story: string
  status: SignatureDishStatus
  firstCookedAt: string
  latestCookedAt: string
  signatureSince?: string
  cookCount: number
  averageRating: number
  heroImageUrl: string
  firstImageUrl: string
  latestImageUrl: string
  keyTips: string[]
  personalIngredientsText: string
  personalStepsText: string
  failurePoint: string
  servingNote: string
  occasionNote: string
  flavorTags: string[]
  visibility: 'private' | 'friends' | 'public'
  attemptIds: string[]
  candidate: boolean
}

export interface ISignatureInsightCount {
  text: string
  count: number
}

export interface ISignatureInsightNote {
  text: string
  date: string
}

export interface ISignatureDishInsights {
  attemptCount: number
  changes: ISignatureInsightCount[]
  feedback: ISignatureInsightCount[]
  diners: ISignatureInsightCount[]
  notes: ISignatureInsightNote[]
  satisfiedCount: number
  averageRating: number
  hasEvidence: boolean
}

const ATTEMPTS_KEY = 'cooking_attempts'
const DISHES_KEY = 'signature_dishes'
const LEGACY_KEY = 'cookingHistory'
const MIGRATION_KEY = 'signature_dish_migrated_v1'

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function statusFor(count: number, changed: boolean, rating: number): SignatureDishStatus {
  if (count >= 4 && rating >= 4) return 'stable'
  if (changed || count >= 2) return 'improving'
  return 'practicing'
}

function candidateFor(attempts: ICookingAttempt[]): boolean {
  const conditions = [
    attempts.length >= 3,
    attempts.filter((item) => item.note.trim()).length >= 2,
    attempts.filter((item) => item.imageUrls.length).length >= 2,
    attempts.slice(0, 3).length >= 3 && attempts.slice(0, 3).reduce((sum, item) => sum + item.rating, 0) / 3 >= 4,
    attempts.some((item) => item.changeNote.trim()),
    attempts.some((item) => item.satisfied),
  ]
  return conditions.filter(Boolean).length >= 3
}

function rebuildDish(recipeId: string, recipeName: string, existing?: ISignatureDish): ISignatureDish {
  const attempts = getCookingAttempts().filter((item) => item.recipeId === recipeId).sort((a, b) => b.cookedAt.localeCompare(a.cookedAt))
  const chronological = [...attempts].reverse()
  const images = chronological.flatMap((item) => item.imageUrls)
  const ratingAttempts = attempts.filter((item) => item.rating > 0)
  const averageRating = ratingAttempts.length ? Math.round((ratingAttempts.reduce((sum, item) => sum + item.rating, 0) / ratingAttempts.length) * 10) / 10 : 0
  const inferredStatus = statusFor(attempts.length, attempts.some((item) => item.changeNote.trim()), averageRating)
  return {
    id: existing?.id || `signature_${encodeURIComponent(recipeId)}`,
    recipeId,
    canonicalName: recipeName,
    personalName: existing?.personalName || recipeName,
    tagline: existing?.tagline || '',
    story: existing?.story || '',
    status: existing?.status === 'signature' || existing?.status === 'family-classic' ? existing.status : inferredStatus,
    firstCookedAt: chronological[0]?.cookedAt || new Date().toISOString(),
    latestCookedAt: attempts[0]?.cookedAt || new Date().toISOString(),
    signatureSince: existing?.signatureSince,
    cookCount: attempts.length,
    averageRating,
    heroImageUrl: existing?.heroImageUrl || images[images.length - 1] || '',
    firstImageUrl: images[0] || '',
    latestImageUrl: images[images.length - 1] || '',
    keyTips: existing?.keyTips || [],
    personalIngredientsText: existing?.personalIngredientsText || '',
    personalStepsText: existing?.personalStepsText || '',
    failurePoint: existing?.failurePoint || '',
    servingNote: existing?.servingNote || '',
    occasionNote: existing?.occasionNote || '',
    flavorTags: existing?.flavorTags || [],
    visibility: existing?.visibility || 'private',
    attemptIds: attempts.map((item) => item.id),
    candidate: existing?.status === 'signature' || existing?.status === 'family-classic' ? false : candidateFor(attempts),
  }
}

export function migrateLegacyCookingHistory(): void {
  if (wx.getStorageSync(MIGRATION_KEY)) return
  const legacy = (wx.getStorageSync(LEGACY_KEY) || []) as { id?: string; recipeId?: string; recipeName?: string; imageUrl?: string; notes?: string; date?: string }[]
  const attempts = getCookingAttempts()
  const known = new Set(attempts.map((item) => item.id))
  legacy.forEach((item, index) => {
    const id = item.id || `legacy_attempt_${index}`
    if (!item.recipeId || known.has(id)) return
    attempts.push({
      id, recipeId: item.recipeId, recipeName: item.recipeName || '未命名菜品', cookedAt: item.date ? `${item.date}T12:00:00.000Z` : new Date().toISOString(),
      rating: 0, imageUrls: item.imageUrl ? [item.imageUrl] : [], note: item.notes || '', changeNote: '', resultTags: [], diners: '', satisfied: false, isMilestone: index === legacy.length - 1,
    })
  })
  wx.setStorageSync(ATTEMPTS_KEY, attempts)
  const recipeMap = new Map(attempts.map((item) => [item.recipeId, item.recipeName]))
  const existing = getSignatureDishes()
  const dishes = Array.from(recipeMap.entries()).map(([recipeId, name]) => rebuildDish(recipeId, name, existing.find((dish) => dish.recipeId === recipeId)))
  wx.setStorageSync(DISHES_KEY, dishes)
  wx.setStorageSync(MIGRATION_KEY, true)
}

export function getCookingAttempts(recipeId?: string): ICookingAttempt[] {
  const all = (wx.getStorageSync(ATTEMPTS_KEY) || []) as ICookingAttempt[]
  return recipeId ? all.filter((item) => item.recipeId === recipeId).sort((a, b) => b.cookedAt.localeCompare(a.cookedAt)) : all
}

export function getSignatureDishes(): ISignatureDish[] {
  return ((wx.getStorageSync(DISHES_KEY) || []) as ISignatureDish[]).map((dish) => ({
    ...dish,
    personalIngredientsText: dish.personalIngredientsText || '', personalStepsText: dish.personalStepsText || '', failurePoint: dish.failurePoint || '', servingNote: dish.servingNote || '', occasionNote: dish.occasionNote || '',
  })).sort((a, b) => b.latestCookedAt.localeCompare(a.latestCookedAt))
}

export function saveCookingAttempt(input: Omit<ICookingAttempt, 'id' | 'cookedAt' | 'isMilestone'>): { attempt: ICookingAttempt; dish: ISignatureDish; becameCandidate: boolean } {
  migrateLegacyCookingHistory()
  const before = getSignatureDishes().find((item) => item.recipeId === input.recipeId)
  const countBefore = getCookingAttempts(input.recipeId).length
  const attempt: ICookingAttempt = {
    ...input, id: makeId('attempt'), cookedAt: new Date().toISOString(), isMilestone: countBefore === 0 || Boolean(input.changeNote.trim()) || input.satisfied,
    milestoneTitle: countBefore === 0 ? '第一次尝试' : input.changeNote.trim() ? '有了自己的改法' : input.satisfied ? '这次很满意' : undefined,
  }
  wx.setStorageSync(ATTEMPTS_KEY, [attempt, ...getCookingAttempts()])
  const dishes = getSignatureDishes()
  const dish = rebuildDish(input.recipeId, input.recipeName, before)
  const index = dishes.findIndex((item) => item.recipeId === input.recipeId)
  if (index >= 0) dishes[index] = dish
  else dishes.unshift(dish)
  wx.setStorageSync(DISHES_KEY, dishes)
  return { attempt, dish, becameCandidate: !before?.candidate && dish.candidate }
}

export function confirmSignatureDish(id: string, personalName: string, tagline: string): ISignatureDish | null {
  const dishes = getSignatureDishes()
  const dish = dishes.find((item) => item.id === id)
  if (!dish) return null
  dish.personalName = personalName.trim() || dish.canonicalName
  dish.tagline = tagline.trim()
  dish.status = 'signature'
  dish.candidate = false
  dish.signatureSince = new Date().toISOString()
  wx.setStorageSync(DISHES_KEY, dishes)
  return dish
}

export function updateSignatureDish(id: string, data: Partial<Pick<ISignatureDish, 'personalName' | 'tagline' | 'story' | 'keyTips' | 'flavorTags' | 'visibility' | 'heroImageUrl' | 'personalIngredientsText' | 'personalStepsText' | 'failurePoint' | 'servingNote' | 'occasionNote'>>): ISignatureDish | null {
  const dishes = getSignatureDishes()
  const index = dishes.findIndex((item) => item.id === id)
  if (index < 0) return null
  dishes[index] = { ...dishes[index], ...data }
  wx.setStorageSync(DISHES_KEY, dishes)
  return dishes[index]
}

export function getSignatureDish(id: string): ISignatureDish | null {
  migrateLegacyCookingHistory()
  return getSignatureDishes().find((item) => item.id === id || item.recipeId === id) || null
}

function countInsights(values: string[], limit: number): ISignatureInsightCount[] {
  const firstSeen = new Map<string, number>()
  const counts = new Map<string, number>()
  values.map((item) => item.trim()).filter(Boolean).forEach((item, index) => {
    if (!firstSeen.has(item)) firstSeen.set(item, index)
    counts.set(item, (counts.get(item) || 0) + 1)
  })
  return Array.from(counts.entries())
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || (firstSeen.get(a.text) || 0) - (firstSeen.get(b.text) || 0))
    .slice(0, limit)
}

/**
 * 从每次实际下厨记录中生成拿手菜摘要。摘要是派生数据，不要求用户维护另一份档案。
 */
export function getSignatureDishInsights(recipeId: string): ISignatureDishInsights {
  const attempts = getCookingAttempts(recipeId)
  const ratingAttempts = attempts.filter((item) => item.rating > 0)
  const changes = countInsights(attempts.map((item) => item.changeNote), 4)
  const feedback = countInsights(attempts.reduce<string[]>((all, item) => all.concat(item.resultTags || []), []), 6)
  const diners = countInsights(attempts.reduce<string[]>((all, item) => {
    const names = (item.diners || '').split(/[、,，/；;\s]|和|与/).map((name) => name.trim()).filter(Boolean)
    return all.concat(names)
  }, []), 5)
  const notes = attempts.filter((item) => item.note.trim()).slice(0, 4).map((item) => ({ text: item.note.trim(), date: item.cookedAt.slice(0, 10) }))
  const averageRating = ratingAttempts.length
    ? Math.round((ratingAttempts.reduce((sum, item) => sum + item.rating, 0) / ratingAttempts.length) * 10) / 10
    : 0
  const satisfiedCount = attempts.filter((item) => item.satisfied).length
  return {
    attemptCount: attempts.length,
    changes,
    feedback,
    diners,
    notes,
    satisfiedCount,
    averageRating,
    hasEvidence: Boolean(changes.length || feedback.length || diners.length || notes.length || satisfiedCount || averageRating),
  }
}

export function getGrowthLabel(status: SignatureDishStatus): string {
  return ({ practicing: '第一次尝试', improving: '逐渐顺手', stable: '稳定发挥', signature: '拿手菜', 'family-classic': '家庭招牌菜' } as Record<SignatureDishStatus, string>)[status]
}

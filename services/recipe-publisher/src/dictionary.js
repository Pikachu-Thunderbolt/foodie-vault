'use strict'

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s\-_/（）()【】\[\]·]/g, '')
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1))
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column]
  }
  return previous[right.length]
}

function similarity(left, right) {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.9
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length)
}

class DictionaryMatcher {
  constructor(db, { cacheMs = 300000 } = {}) { this.db = db; this.cacheMs = cacheMs; this.cache = new Map() }
  collectionOf(kind) { return kind === 'dish' ? 'dish_dictionary' : 'food_dictionary' }
  invalidate(kind) { this.cache.delete(this.collectionOf(kind)) }
  async all(kind) {
    const collection = this.collectionOf(kind); const cached = this.cache.get(collection)
    if (cached && Date.now() - cached.loadedAt < this.cacheMs) return cached.items
    const items = []; let skip = 0
    while (true) {
      const result = await this.db.collection(collection).where({ status: 'ACTIVE' }).skip(skip).limit(100).get()
      items.push(...result.data)
      if (result.data.length < 100) break
      skip += result.data.length
    }
    this.cache.set(collection, { loadedAt: Date.now(), items }); return items
  }
  async match(kind, rawName) {
    const normalized = normalizeName(rawName); const items = await this.all(kind); let best = null
    for (const item of items) for (const candidate of [item.canonicalName, ...(item.aliases || [])]) {
      const candidateNormalized = normalizeName(candidate); const confidence = similarity(normalized, candidateNormalized)
      if (!best || confidence > best.confidence) best = { dictionaryId: item.dictionaryId, canonicalName: item.canonicalName, confidence, source: confidence === 1 ? (candidateNormalized === normalizeName(item.canonicalName) ? 'exact' : 'alias') : 'fuzzy' }
    }
    if (best && best.confidence >= 0.92) return { status: 'matched', ...best }
    if (best && best.confidence >= 0.76) return { status: 'candidate', ...best }
    return { status: 'unmatched', confidence: best?.confidence || 0, candidates: best ? [best] : [] }
  }
}

function addUnresolved(list, item) { return [...list.filter((existing) => existing.fieldPath !== item.fieldPath), item] }

async function normalizeManifest(manifest, matcher) {
  const next = JSON.parse(JSON.stringify(manifest)); let unresolved = Array.isArray(next.unresolvedFields) ? next.unresolvedFields : []
  if (!next.recipe.canonicalDishId) {
    const match = await matcher.match('dish', next.recipe.recipeName)
    if (match.status === 'matched') { next.recipe.canonicalDishId = match.dictionaryId; unresolved = unresolved.filter((item) => item.fieldPath !== 'recipe.canonicalDishId') }
    else unresolved = addUnresolved(unresolved, { fieldPath: 'recipe.canonicalDishId', reasonCode: match.status === 'candidate' ? 'LOW_CONFIDENCE' : 'MISSING_DICTIONARY', reasonDetail: `菜名“${next.recipe.recipeName}”未自动确认`, nextOwner: 'dictionary', blockingPublish: true, candidateValues: match.status === 'candidate' ? [match] : [] })
  }
  for (let index = 0; index < next.ingredients.length; index += 1) {
    const ingredient = next.ingredients[index]; const fieldPath = `ingredients[${index}].canonicalIngredientId`
    if (ingredient.canonicalIngredientId && ingredient.canonicalName) continue
    const match = await matcher.match('ingredient', ingredient.rawName)
    if (match.status === 'matched') {
      ingredient.canonicalIngredientId = match.dictionaryId; ingredient.canonicalName = match.canonicalName; ingredient.normalizationStatus = 'matched'
      unresolved = unresolved.filter((item) => item.fieldPath !== fieldPath && item.fieldPath !== `ingredients[${index}].canonicalName`)
    } else {
      ingredient.normalizationStatus = match.status
      unresolved = addUnresolved(unresolved, { fieldPath, reasonCode: match.status === 'candidate' ? 'LOW_CONFIDENCE' : 'MISSING_DICTIONARY', reasonDetail: `食材“${ingredient.rawName}”未自动确认`, nextOwner: 'dictionary', blockingPublish: ingredient.role === 'core' || ingredient.role === 'required', candidateValues: match.status === 'candidate' ? [match] : [] })
    }
  }
  next.unresolvedFields = unresolved
  if (next.processingStage === 'EXTRACTED') next.processingStage = 'NORMALIZED'
  return next
}

module.exports = { DictionaryMatcher, normalizeManifest, normalizeName }

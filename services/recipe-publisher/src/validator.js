'use strict'

const path = require('path')

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '))
    this.name = 'ValidationError'
    this.errors = errors
  }
}

const HEX_64 = /^[a-f0-9]{64}$/
const MIME_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png'])
const ROLES = new Set(['cover', 'step', 'thumbnail', 'evidence'])
const INGREDIENT_ROLES = new Set(['core', 'required', 'seasoning', 'optional'])
const NORMALIZATION = new Set(['matched', 'candidate', 'unmatched', 'manual'])
const PROCESSING_STAGES = new Set(['EXTRACTED', 'NORMALIZED', 'WAITING_REVIEW', 'PUBLISH_READY'])
const UNRESOLVED_REASONS = new Set(['MISSING_DICTIONARY', 'NOT_STATED_IN_SOURCE', 'LOW_CONFIDENCE', 'CAPABILITY_NOT_ENABLED', 'RIGHTS_PENDING', 'NOT_APPLICABLE'])
const UNRESOLVED_OWNERS = new Set(['dictionary', 'extractor', 'reviewer', 'rights', 'none'])
const RIGHTS_STATUS = new Set(['cleared', 'restricted', 'unknown', 'rejected'])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSafeRelativePath(value) {
  if (!isNonEmptyString(value) || path.isAbsolute(value)) return false
  const normalized = path.normalize(value)
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`)
}

function validateManifest(manifest) {
  const errors = []
  if (!isObject(manifest)) throw new ValidationError(['manifest 必须是对象'])
  if (!isNonEmptyString(manifest.schemaVersion)) errors.push('schemaVersion 必填')
  if (!isNonEmptyString(manifest.packageId)) errors.push('packageId 必填')
  if (!HEX_64.test(manifest.contentHash || '')) errors.push('contentHash 必须是 64 位小写 SHA-256')
  if (!isObject(manifest.producer) || !isNonEmptyString(manifest.producer.systemName) || !isNonEmptyString(manifest.producer.jobId)) {
    errors.push('producer.systemName 和 producer.jobId 必填')
  }
  if (!isObject(manifest.source) || !isNonEmptyString(manifest.source.platform) || !isNonEmptyString(manifest.source.sourceContentId) || !isNonEmptyString(manifest.source.sourceUrl) || !isNonEmptyString(manifest.source.rightsStatus)) {
    errors.push('source 的 platform、sourceContentId、sourceUrl、rightsStatus 必填')
  }
  if (!RIGHTS_STATUS.has(manifest.source?.rightsStatus)) errors.push('source.rightsStatus 无效')
  if (manifest.source?.contentType === 'video' && !(Number(manifest.source.durationSeconds) >= 0)) {
    errors.push('视频来源必须提供 source.durationSeconds')
  }
  if (!isObject(manifest.recipe) || !isNonEmptyString(manifest.recipe.recipeName) || !isNonEmptyString(manifest.recipe.coverAssetId) || typeof manifest.recipe.reviewRequired !== 'boolean') {
    errors.push('recipe 的 recipeName、coverAssetId、reviewRequired 必填')
  }
  if (!Array.isArray(manifest.mediaAssets) || manifest.mediaAssets.length === 0) errors.push('mediaAssets 至少包含一项')
  if (!Array.isArray(manifest.ingredients)) errors.push('ingredients 必须是数组')
  if (!Array.isArray(manifest.steps) || manifest.steps.length === 0) errors.push('steps 至少包含一项')
  if (!isObject(manifest.quality) || !Array.isArray(manifest.quality.evidence)) errors.push('quality.evidence 必须是数组')
  if (!PROCESSING_STAGES.has(manifest.processingStage)) errors.push('processingStage 无效或缺失')
  if (!Array.isArray(manifest.unresolvedFields)) errors.push('unresolvedFields 必须是数组')
  for (const unresolved of manifest.unresolvedFields || []) {
    if (!isObject(unresolved) || !isNonEmptyString(unresolved.fieldPath) || !UNRESOLVED_REASONS.has(unresolved.reasonCode) || !UNRESOLVED_OWNERS.has(unresolved.nextOwner) || typeof unresolved.blockingPublish !== 'boolean') {
      errors.push('每个 unresolvedFields 项必须包含 fieldPath、合法 reasonCode、nextOwner 和 blockingPublish')
    }
  }

  const assetIds = new Set()
  let coverCount = 0
  for (const asset of manifest.mediaAssets || []) {
    if (!isObject(asset) || !isNonEmptyString(asset.assetId) || !isSafeRelativePath(asset.localRelativePath)) {
      errors.push('每个媒体必须有 assetId 和安全的 localRelativePath')
      continue
    }
    if (assetIds.has(asset.assetId)) errors.push(`媒体 assetId 重复：${asset.assetId}`)
    assetIds.add(asset.assetId)
    if (!HEX_64.test(asset.sha256 || '')) errors.push(`媒体 ${asset.assetId} 的 sha256 无效`)
    if (!MIME_TYPES.has(asset.mimeType)) errors.push(`媒体 ${asset.assetId} 的 mimeType 不受支持`)
    if (!ROLES.has(asset.role)) errors.push(`媒体 ${asset.assetId} 的 role 无效`)
    if (!(Number(asset.byteSize) > 0)) errors.push(`媒体 ${asset.assetId} 的 byteSize 无效`)
    if (!(Number(asset.width) > 0 && Number(asset.height) > 0)) errors.push(`媒体 ${asset.assetId} 的宽高无效`)
    if (asset.role === 'cover') coverCount += 1
    if (asset.role === 'step' && !(Number.isInteger(asset.stepNo) && asset.stepNo > 0)) errors.push(`步骤媒体 ${asset.assetId} 缺少 stepNo`)
  }
  if (coverCount !== 1) errors.push('必须且只能有一个 cover 媒体')
  if (!assetIds.has(manifest.recipe?.coverAssetId)) errors.push('recipe.coverAssetId 未指向媒体清单')

  const ingredientRefs = new Set()
  let requiredIngredient = 0
  for (const ingredient of manifest.ingredients || []) {
    if (!isObject(ingredient) || !isNonEmptyString(ingredient.ingredientRef) || !isNonEmptyString(ingredient.rawName)) {
      errors.push('每个食材必须有 ingredientRef 和 rawName')
      continue
    }
    if (ingredientRefs.has(ingredient.ingredientRef)) errors.push(`食材 ingredientRef 重复：${ingredient.ingredientRef}`)
    ingredientRefs.add(ingredient.ingredientRef)
    if (!INGREDIENT_ROLES.has(ingredient.role)) errors.push(`食材 ${ingredient.ingredientRef} 的 role 无效`)
    if (!NORMALIZATION.has(ingredient.normalizationStatus)) errors.push(`食材 ${ingredient.ingredientRef} 的 normalizationStatus 无效`)
    if (typeof ingredient.isOptional !== 'boolean' || ingredient.isOptional !== (ingredient.role === 'optional')) errors.push(`食材 ${ingredient.ingredientRef} 的 isOptional 与 role 不一致`)
    if (!Array.isArray(ingredient.evidenceRefs) || ingredient.evidenceRefs.length === 0) errors.push(`食材 ${ingredient.ingredientRef} 缺少 evidenceRefs`)
    if (ingredient.role === 'core' || ingredient.role === 'required') requiredIngredient += 1
  }
  if (requiredIngredient === 0) errors.push('至少需要一个 core 或 required 食材')

  let expectedStepNo = 1
  for (const step of manifest.steps || []) {
    if (!isObject(step) || step.stepNo !== expectedStepNo || !isNonEmptyString(step.instruction)) errors.push(`步骤 ${expectedStepNo} 的 stepNo 或 instruction 无效`)
    if (!Array.isArray(step?.evidenceRefs) || step.evidenceRefs.length === 0) errors.push(`步骤 ${expectedStepNo} 缺少 evidenceRefs`)
    for (const assetId of step?.imageAssetIds || []) if (!assetIds.has(assetId)) errors.push(`步骤 ${expectedStepNo} 引用了不存在的媒体 ${assetId}`)
    for (const ref of step?.ingredientRefs || []) if (!ingredientRefs.has(ref)) errors.push(`步骤 ${expectedStepNo} 引用了不存在的食材 ${ref}`)
    if (manifest.source?.contentType === 'video' && !(Number(step?.sourceTimeStartSeconds) >= 0 && Number(step?.sourceTimeEndSeconds) >= Number(step?.sourceTimeStartSeconds))) errors.push(`视频步骤 ${expectedStepNo} 的来源时间无效`)
    expectedStepNo += 1
  }
  if (manifest.processingStage === 'PUBLISH_READY') {
    if (manifest.source?.rightsStatus !== 'cleared') errors.push('PUBLISH_READY 必须拥有 cleared 来源授权')
    if (!isNonEmptyString(manifest.recipe?.canonicalDishId)) errors.push('PUBLISH_READY 必须拥有 recipe.canonicalDishId')
    for (const ingredient of manifest.ingredients || []) {
      if ((ingredient.role === 'core' || ingredient.role === 'required') && (!isNonEmptyString(ingredient.canonicalIngredientId) || !isNonEmptyString(ingredient.canonicalName))) {
        errors.push(`PUBLISH_READY 的核心/必需食材必须完成标准化：${ingredient.ingredientRef || 'unknown'}`)
      }
    }
  }
  if (errors.length) throw new ValidationError(errors)
  return manifest
}

module.exports = { ValidationError, validateManifest, isSafeRelativePath }

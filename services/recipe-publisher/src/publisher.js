'use strict'

const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const { ValidationError, validateManifest, isSafeRelativePath } = require('./validator')
const { DictionaryMatcher, normalizeManifest, normalizeName } = require('./dictionary')

const now = () => new Date()
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

function ensurePackagePath(ingestRoot, packagePath) {
  if (!isSafeRelativePath(packagePath)) throw new ValidationError(['packagePath 必须是 INGEST_ROOT 内的安全相对路径'])
  const root = path.resolve(ingestRoot)
  const target = path.resolve(root, packagePath)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new ValidationError(['packagePath 越出 INGEST_ROOT'])
  return target
}

async function readPackage(ingestRoot, packagePath) {
  const dir = ensurePackagePath(ingestRoot, packagePath)
  await fs.access(path.join(dir, 'READY'))
  const raw = await fs.readFile(path.join(dir, 'manifest.json'))
  const manifest = validateManifest(JSON.parse(raw.toString('utf8')))
  if (path.basename(dir) !== manifest.packageId) throw new ValidationError(['目录名必须与 manifest.packageId 相同'])
  return { dir, raw, manifest }
}

async function validateMediaFiles(dir, manifest) {
  const files = []
  for (const asset of manifest.mediaAssets) {
    const filePath = path.resolve(dir, asset.localRelativePath)
    if (!filePath.startsWith(`${dir}${path.sep}`)) throw new ValidationError([`媒体路径越界：${asset.assetId}`])
    const [buffer, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)])
    if (!stat.isFile()) throw new ValidationError([`媒体不是文件：${asset.assetId}`])
    if (stat.size !== asset.byteSize) throw new ValidationError([`媒体大小不匹配：${asset.assetId}`])
    if (sha256(buffer) !== asset.sha256) throw new ValidationError([`媒体 SHA-256 不匹配：${asset.assetId}`])
    files.push({ asset, buffer })
  }
  return files
}

async function writeReceipt(dir, receipt) {
  const target = path.join(dir, 'publisher-receipt.json')
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, target)
}

class RecipePublisher {
  constructor({ cloud, ingestRoot, logger = console }) {
    this.cloud = cloud
    this.db = cloud.database()
    this.ingestRoot = ingestRoot
    this.logger = logger
    this.processing = new Set()
    this.matcher = new DictionaryMatcher(this.db)
  }

  async findOne(collection, query) {
    const result = await this.db.collection(collection).where(query).limit(1).get()
    return result.data[0] || null
  }

  async upsertBy(collection, query, data) {
    const current = await this.findOne(collection, query)
    if (current) {
      await this.db.collection(collection).doc(current._id).update({ data: { ...data, updatedAt: now() } })
      return { ...current, ...data, _id: current._id }
    }
    const created = await this.db.collection(collection).add({ data: { ...query, ...data, createdAt: now(), updatedAt: now() } })
    return { ...query, ...data, _id: created._id }
  }

  async setJob(packageId, data) {
    return this.upsertBy('ingest_jobs', { packageId }, data)
  }

  async uploadMedia(packageId, mediaFiles) {
    const media = []
    for (const { asset, buffer } of mediaFiles) {
      let saved = await this.findOne('media_assets', { sha256: asset.sha256 })
      if (!saved) {
        const ext = asset.mimeType === 'image/webp' ? 'webp' : asset.mimeType === 'image/jpeg' ? 'jpg' : 'png'
        const cloudPath = `recipe-media/v1/${asset.sha256.slice(0, 2)}/${asset.sha256}.${ext}`
        const upload = await this.cloud.uploadFile({ cloudPath, fileContent: buffer })
        const cloudFileId = upload.fileID || upload.fileId
        if (!cloudFileId) throw new Error(`云存储未返回 fileID：${asset.assetId}`)
        saved = await this.upsertBy('media_assets', { sha256: asset.sha256 }, {
          assetId: asset.assetId,
          cloudFileId,
          storagePath: cloudPath,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
          firstPackageId: packageId,
          lastVerifiedAt: now(),
        })
      }
      media.push({ assetId: asset.assetId, mediaAssetId: saved._id, cloudFileId: saved.cloudFileId, role: asset.role, stepNo: asset.stepNo || null })
    }
    return media
  }

  // 候选帧上传：worker 传 base64 → 云存储（按 sha256 去重），供 Dashboard/小程序挑帧显示。
  async uploadFrame(base64Data, mimeType = 'image/jpeg') {
    const buffer = Buffer.from(String(base64Data || ''), 'base64')
    if (!buffer.length) throw new ValidationError(['候选帧内容为空'])
    const hash = sha256(buffer)
    const existing = await this.findOne('media_assets', { sha256: hash })
    if (existing) return { sha256: hash, cloudFileId: existing.cloudFileId, deduped: true }
    const ext = mimeType === 'image/webp' ? 'webp' : mimeType === 'image/png' ? 'png' : 'jpg'
    const cloudPath = `recipe-frame-candidates/v1/${hash.slice(0, 2)}/${hash}.${ext}`
    const upload = await this.cloud.uploadFile({ cloudPath, fileContent: buffer })
    const cloudFileId = upload.fileID || upload.fileId
    if (!cloudFileId) throw new Error('云存储未返回候选帧 fileID')
    await this.upsertBy('media_assets', { sha256: hash }, { cloudFileId, storagePath: cloudPath, mimeType, byteSize: buffer.length, role: 'candidate', lastVerifiedAt: now() })
    return { sha256: hash, cloudFileId, deduped: false }
  }

  async archiveManifest(packageId, manifestHash, raw) {
    const storagePath = `recipe-manifests/v1/${packageId}/${manifestHash}.json`
    const result = await this.cloud.uploadFile({ cloudPath: storagePath, fileContent: raw })
    const cloudFileId = result.fileID || result.fileId
    if (!cloudFileId) throw new Error('云存储未返回 manifest fileID')
    return { manifestCloudFileId: cloudFileId, manifestArchivePath: storagePath }
  }

  async writeRecipe(manifest, manifestHash, media) {
    const source = await this.upsertBy('source_records', {
      platform: manifest.source.platform,
      sourceContentId: manifest.source.sourceContentId,
    }, { ...manifest.source, contentHash: manifest.contentHash })

    const recipeId = `recipe_${manifest.packageId}`
    const versionId = `recipe_version_${manifest.packageId}`
    const recipeSnapshot = { ...manifest.recipe, media }
    await this.upsertBy('recipes', { recipeId }, {
      currentVersionId: versionId,
      name: manifest.recipe.recipeName,
      aliases: manifest.recipe.aliases || [],
      coverAssetId: manifest.recipe.coverAssetId,
      difficulty: manifest.recipe.difficulty || 'unknown',
      totalDurationSeconds: manifest.recipe.totalDurationSeconds || null,
      servings: manifest.recipe.servings || null,
      cuisineTags: manifest.recipe.cuisineTags || [],
      publishStatus: 'DRAFT',
      sourceRecordId: source._id,
    })
    await this.upsertBy('recipe_versions', { versionId }, {
      recipeId,
      versionNumber: 1,
      packageId: manifest.packageId,
      manifestHash,
      sourceRecordId: source._id,
      recipeSnapshot,
      qualitySnapshot: manifest.quality,
      reviewStatus: 'WAITING_REVIEW',
    })
    for (let index = 0; index < manifest.ingredients.length; index += 1) {
      const ingredient = manifest.ingredients[index]
      await this.upsertBy('recipe_ingredients', { versionId, ingredientRef: ingredient.ingredientRef }, {
        recipeId,
        sortKey: index + 1,
        ...ingredient,
      })
    }
    for (const step of manifest.steps) {
      await this.upsertBy('recipe_steps', { versionId, stepNo: step.stepNo }, {
        recipeId,
        sortKey: step.stepNo,
        ...step,
      })
    }
    return { recipeId, versionId, sourceRecordId: source._id }
  }

  async queueDictionaryReview(manifest, packageId) {
    const entries = [{ kind: 'dish', rawName: manifest.recipe.recipeName, unresolved: manifest.unresolvedFields.find((item) => item.fieldPath === 'recipe.canonicalDishId') }]
    for (let index = 0; index < manifest.ingredients.length; index += 1) entries.push({ kind: 'ingredient', rawName: manifest.ingredients[index].rawName, unresolved: manifest.unresolvedFields.find((item) => item.fieldPath === `ingredients[${index}].canonicalIngredientId`) })
    for (const entry of entries) {
      if (!entry.unresolved || !['MISSING_DICTIONARY', 'LOW_CONFIDENCE'].includes(entry.unresolved.reasonCode)) continue
      const normalizedName = normalizeName(entry.rawName)
      const queueKey = `${entry.kind}:${normalizedName}`
      const current = await this.findOne('dictionary_review_queue', { queueKey })
      if (current?.status === 'RESOLVED') continue
      await this.upsertBy('dictionary_review_queue', { queueKey }, {
        dictionaryKind: entry.kind,
        rawName: entry.rawName,
        normalizedName,
        candidateValues: entry.unresolved.candidateValues || [],
        blockingPublish: entry.unresolved.blockingPublish,
        status: 'PENDING',
        lastPackageId: packageId,
        occurrenceCount: Number(current?.occurrenceCount || 0) + 1,
      })
    }
  }

  async publish(packagePath) {
    const { dir, raw, manifest } = await readPackage(this.ingestRoot, packagePath)
    if (this.processing.has(manifest.packageId)) return { packageId: manifest.packageId, status: 'PROCESSING', duplicateRequest: true }
    this.processing.add(manifest.packageId)
    const manifestHash = sha256(raw)
    try {
      const existing = await this.getJob(manifest.packageId)
      if (existing && ['WAITING_REVIEW', 'PUBLISHED'].includes(existing.status)) {
        if (existing.manifestHash !== manifestHash) throw new ValidationError(['已完成的 packageId 不允许替换 manifest 内容；请创建新的 packageId'])
        const result = { packageId: manifest.packageId, status: existing.status, recipeId: existing.recipeId, versionId: existing.versionId, duplicateRequest: true }
        await writeReceipt(dir, { ...result, manifestHash, completedAt: new Date().toISOString() })
        return result
      }
      const attemptCount = Number(existing?.attemptCount || 0) + 1
      await this.setJob(manifest.packageId, { jobId: manifest.producer.jobId, manifestHash, status: 'VALIDATING', attemptCount, packagePath, lastError: null })
      const mediaFiles = await validateMediaFiles(dir, manifest)
      await this.setJob(manifest.packageId, { jobId: manifest.producer.jobId, manifestHash, status: 'UPLOADING_MEDIA', attemptCount, packagePath })
      const media = await this.uploadMedia(manifest.packageId, mediaFiles)
      const archive = await this.archiveManifest(manifest.packageId, manifestHash, raw)
      const normalizedManifest = await normalizeManifest(manifest, this.matcher)
      const ids = await this.writeRecipe(normalizedManifest, manifestHash, media)
      await this.queueDictionaryReview(normalizedManifest, manifest.packageId)
      const result = { packageId: manifest.packageId, status: 'WAITING_REVIEW', ...ids }
      await this.setJob(manifest.packageId, {
        jobId: manifest.producer.jobId, manifestHash, status: 'WAITING_REVIEW', attemptCount, packagePath, ...ids, ...archive,
        recipeName: normalizedManifest.recipe.recipeName, sourcePlatform: normalizedManifest.source.platform,
        sourceContentId: normalizedManifest.source.sourceContentId, sourceTitle: normalizedManifest.source.title || '',
        sourceUrl: normalizedManifest.source.sourceUrl, sourcePublishedAt: normalizedManifest.source.publishedAt || null,
        rightsStatus: normalizedManifest.source.rightsStatus, ingestedAt: now(), localPackageLifecycle: 'ARCHIVED_AND_SAFE_TO_DELETE', lastError: null,
      })
      await writeReceipt(dir, { ...result, manifestHash, completedAt: new Date().toISOString() })
      return result
    } catch (error) {
      const status = error instanceof ValidationError ? 'FAILED_VALIDATION' : 'FAILED_RETRYABLE'
      await this.setJob(manifest.packageId, { jobId: manifest.producer.jobId, manifestHash, status, packagePath, lastError: error.message.slice(0, 1000) })
      await writeReceipt(dir, { packageId: manifest.packageId, status, manifestHash, error: error.message.slice(0, 1000), completedAt: new Date().toISOString() })
      throw error
    } finally {
      this.processing.delete(manifest.packageId)
    }
  }

  async getJob(packageId) {
    return this.findOne('ingest_jobs', { packageId })
  }

  async listJobs(limit = 100) {
    const result = await this.db.collection('ingest_jobs').orderBy('updatedAt', 'desc').limit(Math.min(Math.max(Number(limit) || 100, 1), 100)).get()
    return result.data
  }

  async listDictionaryQueue(status = 'PENDING', limit = 100) {
    const query = status ? { status } : {}
    const result = await this.db.collection('dictionary_review_queue')
      .where(query).orderBy('updatedAt', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 100, 1), 100)).get()
    return result.data
  }

  async getDashboardDetail(packageId) {
    const job = await this.getJob(packageId)
    if (!job) return null
    const [source, recipe, version] = await Promise.all([
      job.sourceRecordId ? this.db.collection('source_records').doc(job.sourceRecordId).get().then((r) => r.data).catch(() => null) : null,
      job.recipeId ? this.findOne('recipes', { recipeId: job.recipeId }) : null,
      job.versionId ? this.findOne('recipe_versions', { versionId: job.versionId }) : null,
    ])
    let localPackageState = 'UNKNOWN'
    if (job.packagePath) {
      try { await fs.access(ensurePackagePath(this.ingestRoot, job.packagePath)); localPackageState = 'PRESENT' } catch (_) { localPackageState = 'DELETED_OR_UNAVAILABLE' }
    }
    return { job, source, recipe, version, localPackageState }
  }

  async resolveDictionaryQueue(queueId, resolution) {
    const queue = await this.db.collection('dictionary_review_queue').doc(queueId).get().then((result) => result.data).catch(() => null)
    if (!queue) throw new ValidationError(['未找到待审核词典项'])
    if (!['map_existing', 'create_new'].includes(resolution?.action)) throw new ValidationError(['resolution.action 必须是 map_existing 或 create_new'])
    const collection = queue.dictionaryKind === 'dish' ? 'dish_dictionary' : 'food_dictionary'
    let dictionary
    if (resolution.action === 'map_existing') {
      if (typeof resolution.dictionaryId !== 'string' || !resolution.dictionaryId) throw new ValidationError(['map_existing 必须提供 dictionaryId'])
      dictionary = await this.findOne(collection, { dictionaryId: resolution.dictionaryId })
      if (!dictionary) throw new ValidationError(['指定的主档不存在'])
    } else {
      if (typeof resolution.canonicalName !== 'string' || !resolution.canonicalName.trim()) throw new ValidationError(['create_new 必须提供 canonicalName'])
      const canonicalName = resolution.canonicalName.trim()
      dictionary = await this.upsertBy(collection, { dictionaryId: `${queue.dictionaryKind === 'dish' ? 'dish' : 'ing'}_${canonicalName}` }, {
        kind: queue.dictionaryKind,
        canonicalName,
        aliases: [],
        category: resolution.category || '其他',
        status: 'ACTIVE',
        seedVersion: 'reviewed',
      })
    }
    const aliases = Array.from(new Set([...(dictionary.aliases || []), queue.rawName].filter((name) => name && name !== dictionary.canonicalName)))
    await this.db.collection(collection).doc(dictionary._id).update({ data: { aliases, updatedAt: now() } })
    await this.db.collection('dictionary_review_queue').doc(queueId).update({ data: {
      status: 'RESOLVED', resolvedDictionaryId: dictionary.dictionaryId, resolutionAction: resolution.action,
      reviewedAt: now(), reviewer: resolution.reviewer || 'content-admin', updatedAt: now(),
    } })
    this.matcher.invalidate(queue.dictionaryKind)
    return { queueId, dictionaryId: dictionary.dictionaryId, canonicalName: dictionary.canonicalName, aliases }
  }

  async publishRecipe(recipeId, reviewer = 'content-admin') {
    const recipe = await this.findOne('recipes', { recipeId })
    if (!recipe) throw new ValidationError(['未找到菜谱'])
    const version = await this.findOne('recipe_versions', { versionId: recipe.currentVersionId })
    const source = version?.sourceRecordId ? await this.db.collection('source_records').doc(version.sourceRecordId).get().then((r) => r.data).catch(() => null) : null
    const ingredients = version ? (await this.db.collection('recipe_ingredients').where({ versionId: version.versionId }).get()).data : []
    if (source?.rightsStatus !== 'cleared') throw new ValidationError(['来源授权尚未确认，不能公开发布'])
    if (!version?.recipeSnapshot?.canonicalDishId) throw new ValidationError(['菜谱主档尚未确认，不能公开发布'])
    if ((version.qualitySnapshot?.blockingErrors || []).length) throw new ValidationError(['存在阻断质检错误，不能公开发布'])
    if (ingredients.some((item) => (item.role === 'core' || item.role === 'required') && (!item.canonicalIngredientId || !item.canonicalName))) throw new ValidationError(['核心或必需食材尚未完成标准化，不能公开发布'])
    const publishedAt = now()
    await this.db.collection('recipes').doc(recipe._id).update({ data: { publishStatus: 'PUBLISHED', publishedAt, updatedAt: publishedAt } })
    await this.db.collection('recipe_versions').doc(version._id).update({ data: { reviewStatus: 'PUBLISHED', reviewedBy: reviewer, reviewedAt: publishedAt, updatedAt: publishedAt } })
    const job = await this.findOne('ingest_jobs', { recipeId })
    if (job) await this.db.collection('ingest_jobs').doc(job._id).update({ data: { status: 'PUBLISHED', publishedAt, reviewer, updatedAt: publishedAt } })
    return { recipeId, publishedAt }
  }

  async scanReadyPackages() {
    const entries = await fs.readdir(this.ingestRoot, { withFileTypes: true })
    const results = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await fs.access(path.join(this.ingestRoot, entry.name, 'READY'))
        const job = await this.getJob(entry.name)
        if (job && ['WAITING_REVIEW', 'PUBLISHED', 'PROCESSING'].includes(job.status)) continue
        results.push(await this.publish(entry.name))
      } catch (error) {
        if (error.code !== 'ENOENT') this.logger.error('[paoding-jieniu] scan failed', entry.name, error)
      }
    }
    return results
  }
}

module.exports = { RecipePublisher, readPackage, validateMediaFiles, writeReceipt }

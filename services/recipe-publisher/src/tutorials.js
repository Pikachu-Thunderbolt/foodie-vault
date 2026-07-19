'use strict'

const { ValidationError } = require('./validator')
const { parseSourceId, getChannel } = require('./channels')

const OWNER_TYPES = new Set(['SYSTEM', 'USER'])
const VISIBILITIES = new Set(['PRIVATE', 'SHARE_PENDING', 'SHARED', 'PUBLIC'])
const NEGATIVE = ['吃播', '试吃', '测评', '开箱', '搞笑', '段子', 'vlog', '探店', '踩雷', '整活', 'reaction', '直播回放', '搬运']
const POSITIVE = ['教程', '做法', '菜谱', '配方', '步骤', '做饭', '烹饪', '家常菜', 'recipe', 'how to cook']
const COOKING_CATEGORIES = ['美食', '美食制作', '生活']

function now() { return new Date() }

// 仅用元数据判定，禁止触发下载。不把“播放量高”作为教程证明。
function evaluateCookingTutorial(metadata = {}) {
  const title = String(metadata.title || '').trim()
  const description = String(metadata.description || metadata.desc || '').trim()
  const tags = Array.isArray(metadata.tags) ? metadata.tags.join(' ') : String(metadata.tags || metadata.tag || '')
  const category = String(metadata.category || metadata.tname || '')
  const duration = Number(metadata.durationSeconds || metadata.duration || 0)
  const text = `${title} ${description} ${tags}`.toLowerCase()
  const reasons = []
  if (!title) return { verdict: 'METADATA_INCOMPLETE', score: 0, reasons: ['缺少视频标题；不得下载'] }
  if (NEGATIVE.some((word) => text.includes(word))) return { verdict: 'REJECTED', score: 0, reasons: ['命中非教程内容排除词'] }
  if (duration && (duration < 45 || duration > 3600)) return { verdict: 'REJECTED', score: 0, reasons: ['时长不在 45 秒至 60 分钟教程范围'] }
  let score = 0
  if (POSITIVE.some((word) => text.includes(word))) { score += 55; reasons.push('标题/描述/标签含做菜教程信号') }
  if (COOKING_CATEGORIES.some((word) => category.includes(word))) { score += 20; reasons.push('B站分区为美食相关') }
  if (duration >= 60 && duration <= 1800) { score += 15; reasons.push('时长适合步骤型教程') }
  if (/(食材|下锅|翻炒|切|腌|炖|蒸|烤|出锅)/.test(text)) { score += 15; reasons.push('存在烹饪动作或食材信号') }
  if (score >= 60) return { verdict: 'PASSED', score, reasons }
  return { verdict: 'MANUAL_REVIEW_REQUIRED', score, reasons: [...reasons, '元数据不足以确认是正常做饭教程'] }
}

class TutorialService {
  constructor({ cloud }) { this.cloud = cloud; this.db = cloud.database() }

  async findOne(collection, query) { const r = await this.db.collection(collection).where(query).limit(1).get(); return r.data[0] || null }
  async upsert(collection, query, data) {
    const old = await this.findOne(collection, query)
    if (old) { await this.db.collection(collection).doc(old._id).update({ data: { ...data, updatedAt: now() } }); return { ...old, ...data, _id: old._id } }
    const result = await this.db.collection(collection).add({ data: { ...query, ...data, createdAt: now(), updatedAt: now() } })
    return { ...query, ...data, _id: result._id }
  }
  async event(tutorialId, type, actor, payload = {}) {
    return this.db.collection('tutorial_audit_events').add({ data: { tutorialId, type, actor, payload, occurredAt: now() } })
  }

  async submitSource(input, actor = 'system') {
    const channelType = input.channelType || 'bilibili'
    const channel = getChannel(channelType)
    const ownerType = input.ownerType || 'USER'
    if (!OWNER_TYPES.has(ownerType)) throw new ValidationError(['ownerType 仅支持 SYSTEM 或 USER'])
    if (ownerType === 'USER' && !input.ownerId) throw new ValidationError(['用户教程必须提供 ownerId'])

    const sourceId = parseSourceId(channelType, input.sourceId || input.sourceUrl || input.bvid)
    const sourceUrl = input.sourceUrl || channel.buildSourceUrl(sourceId)
    const tutorialId = `tutorial_${channelType}_${sourceId}_${ownerType === 'USER' ? String(input.ownerId).slice(0, 32) : 'system'}`

    const current = await this.findOne('tutorials', { tutorialId })
    if (current) return current

    const visibility = ownerType === 'SYSTEM' ? 'PUBLIC' : 'PRIVATE'
    const tutorial = await this.upsert('tutorials', { tutorialId }, {
      channelType,
      sourceId,
      sourceUrl,
      sourceMeta: input.sourceMeta || {},
      sourceData: input.sourceData || {},
      sourceTitle: '',
      ownerType,
      ownerId: input.ownerId || null,
      discoverSource: input.discoverSource || 'direct',
      visibility,
      requestedVisibility: visibility,
      lifecycleStatus: 'PREFLIGHT_PENDING',
      processingStatus: 'NOT_QUEUED',
      reviewPolicy: ownerType === 'SYSTEM' ? 'SYSTEM_REQUIRED' : 'OWNER_REQUIRED',
      currentVersionId: null,
      currentPublishedVersionId: null,
      revisionCount: 0,
      sourceRightsStatus: input.sourceRightsStatus || 'unknown',
    })
    await this.event(tutorialId, 'SUBMITTED', actor, { ownerType, channelType, sourceId })
    return tutorial
  }

  // 向后兼容旧 API
  async submitBilibili(input, actor) {
    return this.submitSource({ ...input, channelType: 'bilibili' }, actor)
  }

  async preflight(tutorialId, metadata, actor = 'discovery-worker') {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    const channel = getChannel(tutorial.channelType)
    const result = channel.evaluateCookingTutorial(metadata)
    const state = result.verdict === 'PASSED' ? 'PREFLIGHT_PASSED' : result.verdict === 'REJECTED' ? 'PREFLIGHT_REJECTED' : 'PREFLIGHT_MANUAL_REVIEW'
    const updated = await this.db.collection('tutorials').doc(tutorial._id).update({ data: {
      sourceTitle: metadata.title || tutorial.sourceTitle,
      sourceMeta: { ...(tutorial.sourceMeta || {}), ...metadata },
      sourceData: { ...(tutorial.sourceData || {}), ...(metadata._sourceData || {}) },
      preflight: { ...result, checkedAt: now(), checkedBy: actor },
      lifecycleStatus: state,
      processingStatus: result.verdict === 'PASSED' ? 'READY_TO_QUEUE' : 'BLOCKED',
      updatedAt: now(),
    } })
    await this.event(tutorialId, 'PREFLIGHT_COMPLETED', actor, result)
    return { tutorialId, ...result, lifecycleStatus: state, updated }
  }

  async requestUpdate(tutorialId, input = {}, actor = 'content-admin') {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    const isOwner = tutorial.ownerType === 'USER' && actor === tutorial.ownerId
    if (tutorial.ownerType === 'USER' && !isOwner && actor !== 'content-admin') throw new ValidationError(['只有教程所有者或后台管理员可发起更新'])
    if (!['PUBLISHED', 'OWNER_APPROVED', 'REJECTED', 'PROCESSING_FAILED'].includes(tutorial.lifecycleStatus)) throw new ValidationError(['当前教程状态不能发起更新'])
    await this.db.collection('tutorials').doc(tutorial._id).update({ data: {
      lifecycleStatus: 'PREFLIGHT_PENDING', processingStatus: 'NOT_QUEUED', requestedVisibility: input.visibility || tutorial.visibility,
      updateRequestedAt: now(), updateReason: input.changeSummary || '源视频或教程内容更新', updatedAt: now(),
    } })
    await this.event(tutorialId, 'UPDATE_REQUESTED', actor, { changeSummary: input.changeSummary || null })
    return { tutorialId, lifecycleStatus: 'PREFLIGHT_PENDING', currentPublishedVersionId: tutorial.currentPublishedVersionId }
  }

  async enqueue(tutorialId, actor = 'content-admin') {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    if (tutorial.lifecycleStatus !== 'PREFLIGHT_PASSED') throw new ValidationError(['未通过"正常做饭教程"预检，禁止下载或处理'])
    const taskId = `task_${tutorialId}_${Date.now()}`
    await this.db.collection('tutorials').doc(tutorial._id).update({ data: { processingStatus: 'QUEUED', lifecycleStatus: 'PROCESSING', activeTaskId: taskId, updatedAt: now() } })
    await this.db.collection('tutorial_processing_tasks').add({ data: { taskId, tutorialId, kind: 'PROCESS', channelType: tutorial.channelType, sourceId: tutorial.sourceId, status: 'QUEUED', createdAt: now(), updatedAt: now() } })
    await this.event(tutorialId, 'PROCESSING_QUEUED', actor, { taskId })
    return { tutorialId, taskId, status: 'QUEUED', kind: 'PROCESS' }
  }

  async claimNext(workerId, kind = 'PROCESS') {
    if (!workerId) throw new ValidationError(['workerId 必填'])
    const tasks = (await this.db.collection('tutorial_processing_tasks').where({ status: 'QUEUED', kind }).orderBy('createdAt', 'asc').limit(1).get()).data
    const task = tasks[0]
    if (!task) return null
    const tutorial = await this.findOne('tutorials', { tutorialId: task.tutorialId })
    // 通用护栏：平台与预检必须成立（防止任何绕过预检的旧任务被领取或下载）。
    const baseOk = tutorial && tutorial.channelType === 'bilibili' && tutorial.preflight?.verdict === 'PASSED'
    const stageOk = kind === 'EXPORT'
      ? tutorial?.lifecycleStatus === 'READY_TO_EXPORT'
      : (tutorial?.lifecycleStatus === 'PROCESSING' && tutorial?.processingStatus === 'QUEUED')
    if (!baseOk || !stageOk) {
      await this.db.collection('tutorial_processing_tasks').doc(task._id).update({ data: { status: 'BLOCKED', blockReason: 'STATE_GUARD', updatedAt: now() } })
      return null
    }
    await this.db.collection('tutorial_processing_tasks').doc(task._id).update({ data: { status: 'CLAIMED', workerId, claimedAt: now(), updatedAt: now() } })
    await this.db.collection('tutorials').doc(tutorial._id).update({ data: { processingStatus: kind === 'EXPORT' ? 'EXPORTING' : 'DOWNLOADING', updatedAt: now() } })
    await this.event(tutorial.tutorialId, 'TASK_CLAIMED', workerId, { taskId: task.taskId, kind })
    return { ...task, status: 'CLAIMED', tutorial }
  }

  async updateTask(taskId, input, actor = 'paoding-worker') {
    const task = await this.findOne('tutorial_processing_tasks', { taskId }); if (!task) throw new ValidationError(['未找到处理任务'])
    if (!['DOWNLOADING', 'TRANSCRIBING', 'EXTRACTING', 'PACKAGING', 'EXPORTING', 'COMPLETED', 'FAILED'].includes(input.status)) throw new ValidationError(['无效的任务状态'])
    await this.db.collection('tutorial_processing_tasks').doc(task._id).update({ data: { status: input.status, progress: input.progress || null, error: input.error || null, updatedAt: now(), completedAt: input.status === 'COMPLETED' || input.status === 'FAILED' ? now() : null } })
    const tutorial = await this.findOne('tutorials', { tutorialId: task.tutorialId })
    if (tutorial) await this.db.collection('tutorials').doc(tutorial._id).update({ data: { processingStatus: input.status, lifecycleStatus: input.status === 'FAILED' ? 'PROCESSING_FAILED' : tutorial.lifecycleStatus, updatedAt: now() } })
    await this.event(task.tutorialId, 'TASK_STATUS_UPDATED', actor, { taskId, status: input.status, progress: input.progress || null })
    return { taskId, status: input.status }
  }

  async registerVersion(input, actor = 'paoding-worker') {
    const tutorial = await this.findOne('tutorials', { tutorialId: input.tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    if (!input.packageId || !input.recipeId || !input.versionId) throw new ValidationError(['必须提供 packageId、recipeId、versionId'])
    const versionNumber = Number(tutorial.revisionCount || 0) + 1
    const reviewStatus = tutorial.ownerType === 'SYSTEM' ? 'SYSTEM_REVIEW_REQUIRED' : 'OWNER_REVIEW_REQUIRED'
    const revision = await this.upsert('tutorial_revisions', { tutorialId: tutorial.tutorialId, versionId: input.versionId }, {
      versionNumber, packageId: input.packageId, recipeId: input.recipeId, manifestHash: input.manifestHash || null,
      changeSummary: input.changeSummary || (versionNumber === 1 ? '首次处理完成' : '教程内容更新'),
      reviewStatus, releaseStatus: 'DRAFT', submittedBy: actor,
    })
    await this.db.collection('tutorials').doc(tutorial._id).update({ data: { currentVersionId: input.versionId, revisionCount: versionNumber, lifecycleStatus: reviewStatus, processingStatus: 'COMPLETE', updatedAt: now() } })
    await this.event(tutorial.tutorialId, 'VERSION_REGISTERED', actor, { versionId: input.versionId, packageId: input.packageId, versionNumber })
    return { tutorialId: tutorial.tutorialId, revision, reviewStatus }
  }

  // —— 抽帧后登记草稿：暂停等待人工挑帧 ——
  async registerDraft(tutorialId, input, actor = 'paoding-worker') {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    const steps = Array.isArray(input.steps) ? input.steps : []
    if (!steps.length) throw new ValidationError(['草稿必须包含步骤'])
    await this.upsert('tutorial_frame_drafts', { tutorialId }, {
      recipeName: input.recipeName || '',
      sourceId: tutorial.sourceId,
      steps, // [{stepIndex,name,description,candidates:[{frameType,slot,cloudFileId}]}]
      selection: null,
      reviewerType: tutorial.ownerType, // SYSTEM→管理员挑；USER→所有者挑
    })
    await this.db.collection('tutorials').doc(tutorial._id).update({ data: {
      lifecycleStatus: 'FRAMES_REVIEW', processingStatus: 'FRAMES_EXTRACTED', updatedAt: now(),
    } })
    // 关闭当前 PROCESS 任务。
    const active = await this.findOne('tutorial_processing_tasks', { tutorialId, kind: 'PROCESS', status: 'CLAIMED' })
    if (active) await this.db.collection('tutorial_processing_tasks').doc(active._id).update({ data: { status: 'COMPLETED', completedAt: now(), updatedAt: now() } })
    await this.event(tutorialId, 'DRAFT_REGISTERED', actor, { stepCount: steps.length })
    return { tutorialId, lifecycleStatus: 'FRAMES_REVIEW', stepCount: steps.length }
  }

  async getDraft(tutorialId) {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) return null
    const draft = await this.findOne('tutorial_frame_drafts', { tutorialId })
    return { tutorial, draft }
  }

  // —— 提交挑帧结果：SYSTEM 由管理员(受令牌保护)，USER 仅所有者本人 ——
  async submitFrameSelection(tutorialId, selections, actor) {
    const tutorial = await this.findOne('tutorials', { tutorialId })
    if (!tutorial) throw new ValidationError(['未找到教程'])
    if (tutorial.lifecycleStatus !== 'FRAMES_REVIEW') throw new ValidationError(['当前教程不在挑帧阶段'])
    if (tutorial.ownerType === 'USER' && actor !== tutorial.ownerId) throw new ValidationError(['仅教程所有者可为自己的教程挑选代表帧'])
    const draft = await this.findOne('tutorial_frame_drafts', { tutorialId })
    if (!draft) throw new ValidationError(['未找到待挑帧的草稿'])
    if (!Array.isArray(selections) || !selections.length) throw new ValidationError(['selections 必填：每步选定 {stepIndex, frameType, slot}'])
    await this.db.collection('tutorial_frame_drafts').doc(draft._id).update({ data: { selection: selections, selectedBy: actor, selectedAt: now(), updatedAt: now() } })
    const taskId = `export_${tutorialId}_${Date.now()}`
    await this.db.collection('tutorials').doc(tutorial._id).update({ data: { lifecycleStatus: 'READY_TO_EXPORT', processingStatus: 'EXPORT_QUEUED', activeTaskId: taskId, updatedAt: now() } })
    await this.db.collection('tutorial_processing_tasks').add({ data: { taskId, tutorialId, kind: 'EXPORT', channelType: tutorial.channelType, sourceId: tutorial.sourceId, status: 'QUEUED', createdAt: now(), updatedAt: now() } })
    await this.event(tutorialId, 'FRAMES_SELECTED', actor, { taskId, stepCount: selections.length })
    return { tutorialId, taskId, status: 'QUEUED', kind: 'EXPORT' }
  }

  async review(tutorialId, input, actor) {
    const tutorial = await this.findOne('tutorials', { tutorialId }); if (!tutorial) throw new ValidationError(['未找到教程'])
    const revision = await this.findOne('tutorial_revisions', { tutorialId, versionId: input.versionId || tutorial.currentVersionId }); if (!revision) throw new ValidationError(['未找到待审版本'])
    const action = input.action
    if (!['OWNER_APPROVE', 'REQUEST_SHARE', 'REQUEST_PUBLIC', 'SYSTEM_APPROVE', 'REJECT'].includes(action)) throw new ValidationError(['审核动作无效'])
    const isOwner = actor && actor === tutorial.ownerId
    if (action === 'OWNER_APPROVE' && (tutorial.ownerType !== 'USER' || !isOwner || revision.reviewStatus !== 'OWNER_REVIEW_REQUIRED')) throw new ValidationError(['仅教程所有者可完成自己的私有教程审核'])
    if ((action === 'REQUEST_SHARE' || action === 'REQUEST_PUBLIC') && (tutorial.ownerType !== 'USER' || !isOwner || revision.reviewStatus !== 'OWNER_APPROVED')) throw new ValidationError(['用户须先完成自审，才能申请分享或公开'])
    if (action === 'SYSTEM_APPROVE' && revision.reviewStatus !== 'SYSTEM_REVIEW_REQUIRED') throw new ValidationError(['当前版本不在系统审核队列'])
    if (action === 'OWNER_APPROVE') {
      await this.db.collection('tutorial_revisions').doc(revision._id).update({ data: { reviewStatus: 'OWNER_APPROVED', reviewedBy: actor, reviewedAt: now(), updatedAt: now() } })
      await this.db.collection('tutorials').doc(tutorial._id).update({ data: { lifecycleStatus: 'OWNER_APPROVED', updatedAt: now() } })
    } else if (action === 'REQUEST_SHARE' || action === 'REQUEST_PUBLIC') {
      const requestedVisibility = action === 'REQUEST_PUBLIC' ? 'PUBLIC' : 'SHARED'
      await this.db.collection('tutorial_revisions').doc(revision._id).update({ data: { reviewStatus: 'SYSTEM_REVIEW_REQUIRED', requestedVisibility, updatedAt: now() } })
      await this.db.collection('tutorials').doc(tutorial._id).update({ data: { lifecycleStatus: 'SYSTEM_REVIEW_REQUIRED', requestedVisibility, visibility: 'SHARE_PENDING', updatedAt: now() } })
      await this.upsert('tutorial_review_requests', { tutorialId, versionId: revision.versionId }, { kind: requestedVisibility, status: 'PENDING', requestedBy: actor })
    } else if (action === 'SYSTEM_APPROVE') {
      if (tutorial.sourceRightsStatus !== 'cleared') throw new ValidationError(['来源授权未确认，系统不得发布或分享'])
      const visibility = revision.requestedVisibility || tutorial.visibility || 'PUBLIC'
      await this.db.collection('tutorial_revisions').doc(revision._id).update({ data: { reviewStatus: 'SYSTEM_APPROVED', releaseStatus: 'PUBLISHED', reviewedBy: actor, reviewedAt: now(), publishedAt: now(), updatedAt: now() } })
      await this.db.collection('tutorials').doc(tutorial._id).update({ data: { lifecycleStatus: 'PUBLISHED', visibility, currentPublishedVersionId: revision.versionId, publishedAt: now(), updatedAt: now() } })
    } else {
      await this.db.collection('tutorial_revisions').doc(revision._id).update({ data: { reviewStatus: 'REJECTED', rejectionReason: input.reason || '审核未通过', reviewedBy: actor, reviewedAt: now(), updatedAt: now() } })
      await this.db.collection('tutorials').doc(tutorial._id).update({ data: { lifecycleStatus: 'REJECTED', updatedAt: now() } })
    }
    await this.event(tutorialId, action, actor, { versionId: revision.versionId, reason: input.reason || null })
    return { tutorialId, versionId: revision.versionId, action }
  }

  // ——— 菜品模糊匹配 ———
  // 基于菜名 + 食材签名计算相似度，返回候选菜品列表
  async matchDish(recipeName, ingredients = []) {
    const allDishes = await this.db.collection('dish_dictionary').limit(200).get()
    const dishes = allDishes.data

    const results = dishes.map(dish => {
      let score = 0
      const reasons = []

      // 1) 菜名完全匹配
      if (dish.canonicalName === recipeName) { score += 100; reasons.push('菜名完全匹配') }
      // 2) 别名匹配
      else if ((dish.aliases || []).some(a => a === recipeName)) { score += 95; reasons.push('别名匹配') }
      // 3) 子串匹配
      else if (dish.canonicalName.includes(recipeName) || recipeName.includes(dish.canonicalName)) {
        score += 70; reasons.push('菜名包含关系')
      }
      // 4) 别名子串
      else if ((dish.aliases || []).some(a => recipeName.includes(a) || a.includes(recipeName))) {
        score += 60; reasons.push('别名包含关系')
      }

      // 5) 食材签名 Jaccard 相似度
      const dishSigs = dish.ingredientSignature || []
      const recipeSigs = ingredients.map(i => (i.canonicalName || i.rawName || '').toLowerCase())
      if (dishSigs.length > 0 && recipeSigs.length > 0) {
        const intersection = dishSigs.filter(s => recipeSigs.some(r => r.includes(s) || s.includes(r)))
        const union = new Set([...dishSigs, ...recipeSigs])
        const jaccard = intersection.length / union.size
        score += Math.round(jaccard * 50)
        if (jaccard > 0.5) reasons.push(`食材重合度${Math.round(jaccard*100)}%`)
      }

      return { dish, score, reasons }
    })

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, 5).filter(r => r.score > 20)
  }

  // 菜品字典管理：列出所有菜名及其别名
  async listDishDictionary(limit = 200) {
    const allDishes = await this.db.collection('dish_dictionary').limit(limit).get()
    return allDishes.data
  }

  // 更新菜品字典（添加/修改别名等）
  async upsertDishDictionary(query, data) {
    return this.upsert('dish_dictionary', query, { ...data, updatedAt: now() })
  }

  async list(limit = 100) { return (await this.db.collection('tutorials').orderBy('updatedAt', 'desc').limit(Math.min(Math.max(Number(limit) || 100, 1), 100)).get()).data }
  async get(tutorialId) {
    const tutorial = await this.findOne('tutorials', { tutorialId }); if (!tutorial) return null
    const [revisions, tasks, events] = await Promise.all([
      this.db.collection('tutorial_revisions').where({ tutorialId }).orderBy('versionNumber', 'desc').get().then((r) => r.data),
      this.db.collection('tutorial_processing_tasks').where({ tutorialId }).orderBy('createdAt', 'desc').get().then((r) => r.data),
      this.db.collection('tutorial_audit_events').where({ tutorialId }).orderBy('occurredAt', 'desc').limit(50).get().then((r) => r.data),
    ])
    return { tutorial, revisions, tasks, events }
  }
}

module.exports = { TutorialService, evaluateCookingTutorial }

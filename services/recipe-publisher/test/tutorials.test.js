'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs/promises')
const { createLocalCloud } = require('../src/local-cloud')
const { TutorialService, evaluateCookingTutorial } = require('../src/tutorials')

test('preflight rejects non-tutorials and never lets them queue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const service = new TutorialService({ cloud: createLocalCloud(root) })
  const tutorial = await service.submitBilibili({ bvid: 'BV1abcDEF12', ownerType: 'SYSTEM', sourceRightsStatus: 'cleared' })
  const result = await service.preflight(tutorial.tutorialId, { title: '周末吃播测评', duration: 300, category: '美食' })
  assert.equal(result.verdict, 'REJECTED')
  await assert.rejects(() => service.enqueue(tutorial.tutorialId), /禁止下载或处理/)
})

test('user tutorial must self-review then receive system approval for sharing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const cloud = createLocalCloud(root)
  const service = new TutorialService({ cloud })
  const tutorial = await service.submitBilibili({ bvid: 'BV1abcDEF34', ownerType: 'USER', ownerId: 'user-1', sourceRightsStatus: 'cleared' })
  const passed = await service.preflight(tutorial.tutorialId, { title: '番茄炒蛋做法教程', description: '切番茄，下锅翻炒，食材简单', duration: 260, category: '美食制作' })
  assert.equal(passed.verdict, 'PASSED')
  await service.enqueue(tutorial.tutorialId)
  const task = await service.claimNext('worker-1')
  assert.equal(task.tutorial.bvid, 'BV1abcDEF34')
  await service.registerVersion({ tutorialId: tutorial.tutorialId, packageId: 'pkg-1', recipeId: 'recipe-1', versionId: 'version-1' })
  await service.review(tutorial.tutorialId, { action: 'OWNER_APPROVE' }, 'user-1')
  await service.review(tutorial.tutorialId, { action: 'REQUEST_SHARE' }, 'user-1')
  await service.review(tutorial.tutorialId, { action: 'SYSTEM_APPROVE' }, 'admin')
  const detail = await service.get(tutorial.tutorialId)
  assert.equal(detail.tutorial.lifecycleStatus, 'PUBLISHED')
  assert.equal(detail.tutorial.visibility, 'SHARED')
  assert.equal(detail.tutorial.currentPublishedVersionId, 'version-1')
})

test('preflight does not use popularity as a tutorial bypass', () => {
  const value = evaluateCookingTutorial({ title: '某某明星的日常', duration: 180, views: 9000000, category: '生活' })
  assert.equal(value.verdict, 'MANUAL_REVIEW_REQUIRED')
})

test('system approval refuses to publish when source rights are not cleared', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const service = new TutorialService({ cloud: createLocalCloud(root) })
  const tutorial = await service.submitBilibili({ bvid: 'BV1abcDEF78', ownerType: 'SYSTEM', sourceRightsStatus: 'unknown' })
  await service.preflight(tutorial.tutorialId, { title: '土豆丝做法教程', description: '切丝下锅翻炒', duration: 200, category: '美食制作' })
  await service.enqueue(tutorial.tutorialId)
  await service.registerVersion({ tutorialId: tutorial.tutorialId, packageId: 'pkg-x', recipeId: 'recipe-x', versionId: 'version-x' })
  await assert.rejects(() => service.review(tutorial.tutorialId, { action: 'SYSTEM_APPROVE' }, 'admin'), /来源授权/)
})

test('an update keeps the previously published version available until replacement review', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const service = new TutorialService({ cloud: createLocalCloud(root) })
  const tutorial = await service.submitBilibili({ bvid: 'BV1abcDEF56', ownerType: 'SYSTEM', sourceRightsStatus: 'cleared' })
  await service.preflight(tutorial.tutorialId, { title: '红烧茄子做法教程', description: '切茄子，下锅炒熟', duration: 220, category: '美食制作' })
  await service.enqueue(tutorial.tutorialId); await service.registerVersion({ tutorialId: tutorial.tutorialId, packageId: 'pkg-v1', recipeId: 'recipe-v1', versionId: 'version-v1' })
  await service.review(tutorial.tutorialId, { action: 'SYSTEM_APPROVE' }, 'admin')
  await service.requestUpdate(tutorial.tutorialId, { changeSummary: '补充关键帧' }, 'content-admin')
  const detail = await service.get(tutorial.tutorialId)
  assert.equal(detail.tutorial.currentPublishedVersionId, 'version-v1')
  assert.equal(detail.tutorial.lifecycleStatus, 'PREFLIGHT_PENDING')
})

// —— 单容器阶段：草稿 + 人工挑帧状态机 ——
async function toFramesReview(service, ownerType, ownerId) {
  const bvid = `BV1draft${Math.floor(ownerId ? 1 : 2)}${ownerType[0]}`
  const tutorial = await service.submitBilibili({ bvid, ownerType, ownerId, sourceRightsStatus: 'cleared' })
  await service.preflight(tutorial.tutorialId, { title: '青椒肉丝做法教程', description: '切丝下锅翻炒', duration: 240, category: '美食制作' })
  await service.enqueue(tutorial.tutorialId)
  await service.claimNext('w1', 'PROCESS')
  await service.registerDraft(tutorial.tutorialId, { recipeName: '青椒肉丝', steps: [
    { stepIndex: 0, name: '切丝', description: '肉切丝', candidates: [{ frameType: 'key', slot: 0, cloudFileId: 'cf-a' }] },
    { stepIndex: 1, name: '翻炒', description: '下锅炒', candidates: [{ frameType: 'key', slot: 0, cloudFileId: 'cf-b' }] },
  ] })
  return tutorial
}

test('draft registration pauses the tutorial at FRAMES_REVIEW', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const service = new TutorialService({ cloud: createLocalCloud(root) })
  const tutorial = await toFramesReview(service, 'SYSTEM', null)
  const detail = await service.get(tutorial.tutorialId)
  assert.equal(detail.tutorial.lifecycleStatus, 'FRAMES_REVIEW')
  const draft = await service.getDraft(tutorial.tutorialId)
  assert.equal(draft.draft.steps.length, 2)
})

test('SYSTEM frame selection creates an EXPORT task claimable by kind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const service = new TutorialService({ cloud: createLocalCloud(root) })
  const tutorial = await toFramesReview(service, 'SYSTEM', null)
  await service.submitFrameSelection(tutorial.tutorialId, [
    { stepIndex: 0, frameType: 'key', slot: 0 }, { stepIndex: 1, frameType: 'key', slot: 0 },
  ], 'admin')
  const exportTask = await service.claimNext('w1', 'EXPORT')
  assert.equal(exportTask.kind, 'EXPORT')
  assert.equal(exportTask.tutorial.tutorialId, tutorial.tutorialId)
})

test('USER frame selection is refused for anyone but the owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-'))
  const service = new TutorialService({ cloud: createLocalCloud(root) })
  const tutorial = await toFramesReview(service, 'USER', 'user-9')
  await assert.rejects(() => service.submitFrameSelection(tutorial.tutorialId, [{ stepIndex: 0, frameType: 'key', slot: 0 }], 'someone-else'), /所有者/)
  const ok = await service.submitFrameSelection(tutorial.tutorialId, [{ stepIndex: 0, frameType: 'key', slot: 0 }], 'user-9')
  assert.equal(ok.kind, 'EXPORT')
})

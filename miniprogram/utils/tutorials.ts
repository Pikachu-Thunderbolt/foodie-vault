// utils/tutorials.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 教程接入：封装 tutorials 云函数。读已发布/自有教程，代理治理写操作。
// 后台状态机与审核由 Node 控制面强制，这里只做调用与类型约束。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { callFn } from './cloud'

export interface ITutorialIngredient {
  name: string
  amountText: string
  role: string
  optional: boolean
}

export interface ITutorialStep {
  stepNo: number
  desc: string
  imageUrl: string
  durationSeconds: number | null
}

/** 已发布/详情教程的完整渲染结构（映射自控制面 manifest）。 */
export interface ITutorial {
  tutorialId: string
  recipeId: string
  versionId: string
  name: string
  coverUrl: string
  summary: string
  difficulty: string
  totalDurationSeconds: number | null
  servings: number | null
  cuisineTags: string[]
  ownerType: 'SYSTEM' | 'USER'
  visibility: 'PRIVATE' | 'SHARE_PENDING' | 'SHARED' | 'PUBLIC'
  source: { channelType: string; url: string; sourceId: string; title: string }
  ingredients: ITutorialIngredient[]
  steps: ITutorialStep[]
}

/** “我的教程”列表摘要。 */
export interface ITutorialSummary {
  tutorialId: string
  sourceId: string
  channelType: string
  sourceTitle: string
  lifecycleStatus: string
  visibility: string
  currentVersionId: string | null
  updatedAt: string
}

/** 用户挑帧草稿：每步的候选帧。 */
export interface ITutorialDraftCandidate {
  frameType: string
  slot: number
  url: string
}
export interface ITutorialDraftStep {
  stepIndex: number
  name: string
  description: string
  candidates: ITutorialDraftCandidate[]
}
export interface ITutorialDraft {
  tutorialId: string
  lifecycleStatus: string
  recipeName: string
  steps: ITutorialDraftStep[]
}

/** 一步的挑帧结果。 */
export interface IFrameSelection {
  stepIndex: number
  frameType: string
  slot: number
}

export type OwnerReviewAction = 'OWNER_APPROVE' | 'REQUEST_SHARE' | 'REQUEST_PUBLIC'

/** 公开教程列表（发现页）。 */
export function listPublicTutorials(limit = 30): Promise<ITutorial[]> {
  return callFn<ITutorial[]>('tutorials', { action: 'listPublic', limit })
}

/** 我上传的教程（含私有）。 */
export function listMyTutorials(): Promise<ITutorialSummary[]> {
  return callFn<ITutorialSummary[]>('tutorials', { action: 'listMine' })
}

/** 教程详情（私有仅所有者可见）。 */
export function getTutorialDetail(tutorialId: string): Promise<ITutorial> {
  return callFn<ITutorial>('tutorials', { action: 'detail', tutorialId })
}

/** 提交一条自有 B站视频作为用户教程（进入所有者自审流程）。 */
export function submitBilibiliTutorial(bvid: string): Promise<{ tutorialId: string }> {
  return callFn('tutorials', { action: 'submit', bvid })
}

/** 拉取自有教程的挑帧草稿（候选帧带临时 URL）。 */
export function getTutorialDraft(tutorialId: string): Promise<ITutorialDraft> {
  return callFn<ITutorialDraft>('tutorials', { action: 'getDraft', tutorialId })
}

/** 提交用户挑帧结果（每步一张代表帧）→ 触发导出。 */
export function submitFrameSelection(
  tutorialId: string,
  selections: IFrameSelection[]
): Promise<{ tutorialId: string; taskId: string }> {
  return callFn('tutorials', { action: 'submitFrameSelection', tutorialId, selections })
}

/**
 * 教程审核动作：
 *  - OWNER_APPROVE：所有者完成私有自审
 *  - REQUEST_SHARE / REQUEST_PUBLIC：自审后申请分享/公开（进入系统审核）
 */
export function reviewTutorial(
  tutorialId: string,
  reviewAction: OwnerReviewAction,
  opts: { versionId?: string; reason?: string } = {}
): Promise<{ tutorialId: string; versionId: string; action: string }> {
  return callFn('tutorials', { action: 'review', tutorialId, reviewAction, ...opts })
}

/** 对已发布/已通过的教程发起内容更新（旧公开版保留至新版通过）。 */
export function requestTutorialUpdate(
  tutorialId: string,
  opts: { changeSummary?: string; visibility?: string } = {}
): Promise<{ tutorialId: string; lifecycleStatus: string }> {
  return callFn('tutorials', { action: 'requestUpdate', tutorialId, ...opts })
}

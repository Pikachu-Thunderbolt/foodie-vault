// utils/cloud.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 云函数调用基础：Promise 化、统一错误处理、openid/用户档案缓存、启动引导。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { runFirstMigration } from './migration'
import { pullSync } from './sync'

const ENV_ID = 'foodie-vault-cloud-d7c230e4c1807'
const CLOUD_NOT_ENABLED_CODE = -601034

export interface CloudResponse<T> {
  code: number
  data: T
  msg?: string
}

export class CloudError extends Error {
  code: number
  constructor(code: number, msg: string) {
    super(msg)
    this.code = code
    this.name = 'CloudError'
  }
}

let inited = false

/** 微信客户端把云开发权限错误包在 Error.message 中，部分基础库不会暴露 errCode 字段。 */
function isCloudNotEnabledError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const cloudErr = err as { errCode?: number | string; message?: string }
  return (
    Number(cloudErr.errCode) === CLOUD_NOT_ENABLED_CODE ||
    cloudErr.message?.includes(`errCode: ${CLOUD_NOT_ENABLED_CODE}`) === true
  )
}

export function ensureInit(): void {
  if (inited) return
  if (!wx.cloud) {
    console.warn('[cloud] 当前微信版本不支持云开发')
    return
  }
  wx.cloud.init({ env: ENV_ID, traceUser: true })
  inited = true
}

export async function callFn<T = unknown>(
  name: string,
  data: Record<string, unknown> = {}
): Promise<T> {
  ensureInit()
  try {
    const res = (await wx.cloud.callFunction({ name, data })) as { result: CloudResponse<T> }
    const payload = res && res.result
    if (!payload || typeof payload !== 'object' || !('code' in payload)) {
      throw new CloudError(-1, `云函数 ${name} 返回格式异常`)
    }
    if (payload.code !== 0) {
      throw new CloudError(payload.code, payload.msg || `云函数 ${name} 错误`)
    }
    return payload.data
  } catch (err) {
    if (err instanceof CloudError) {
      console.warn(`[cloud] ${name} 业务错误 code=${err.code} msg=${err.message}`)
      throw err
    }
    if (isCloudNotEnabledError(err)) {
      console.error(`[cloud] ${name} 云开发未开通或环境无权限`, err)
      throw new CloudError(
        CLOUD_NOT_ENABLED_CODE,
        '云开发服务未开通或当前小程序无权限，请联系管理员配置后重试'
      )
    }
    console.error(`[cloud] ${name} 调用失败`, err)
    throw new CloudError(-1, `网络异常（${name}）`)
  }
}

// ——— 用户档案 ———

export interface IUserDoc {
  _id: string
  nickname: string
  avatarUrl: string
  gender: string
  tastePreference: string
  dietaryRestrictions: string[]
  difficultyLevel: string
  reminderDays: number
  themeGender: string
}

export interface ILoginResult {
  openid: string
  isNew: boolean
  user: IUserDoc
}

const OPENID_KEY = '_openid_cache'
const USER_KEY = '_user_cache'

export function getCachedOpenid(): string | null {
  return wx.getStorageSync(OPENID_KEY) || null
}

export function getCachedUser(): IUserDoc | null {
  const u = wx.getStorageSync(USER_KEY) || null
  return u && typeof u === 'object' ? (u as IUserDoc) : null
}

export function setCachedUser(user: IUserDoc): void {
  wx.setStorageSync(USER_KEY, user)
}

/**
 * 登录云函数。
 * - 首次登录：传 profile（来自用户授权）→ 创建 users 文档
 * - 后续启动：只传 openid → 静默更新 lastSeenAt
 */
export async function login(profile?: {
  nickname?: string
  avatarUrl?: string
  gender?: string
}): Promise<ILoginResult> {
  const data = await callFn<ILoginResult>('login', { profile: profile || {} })
  wx.setStorageSync(OPENID_KEY, data.openid)
  setCachedUser(data.user)
  return data
}

// ——— 启动引导（不阻塞首屏） ——

let bootstrapped = false

/**
 * 启动流程：
 *   1. 如果本地没有 openid 缓存 → 调用 login 建档（首次授权后才会触发）
 *   2. 否则只刷新 lastSeenAt
 *   3. 异步跑：首次迁移 + 增量拉取
 */
export async function bootstrap(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true
  try {
    ensureInit()
    if (!getCachedOpenid()) {
      // 没有缓存 openid，跳过云端调用，等用户在登录页主动授权
      return
    }
    // 有缓存 → 静默 refresh（失败也不影响 UI）
    login().catch((err) => console.warn('[cloud] 静默登录失败', err))

    // 后台异步：首次迁移 → 拉取同步。两步串行，但都不阻塞首屏
    runFirstMigration()
      .then(pullSync)
      .catch((err) => console.warn('[cloud] 后台同步失败', err))
  } catch (err) {
    console.warn('[cloud] bootstrap 失败', err)
  }
}

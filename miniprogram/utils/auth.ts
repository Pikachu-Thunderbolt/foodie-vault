// utils/auth.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 用户状态：当前用户档案（来自 _user_cache + openid）、登录 / 登出、路由守卫。
// 页面层推荐用 getCurrentUser() 拿当前用户；不要直接读 wx.storageSync。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { login, getCachedOpenid, getCachedUser, setCachedUser } from './cloud'

export interface IAppUser {
  _id: string
  openid: string
  nickname: string
  avatarUrl: string
  gender: string
  tastePreference: string
  dietaryRestrictions: string[]
  difficultyLevel: string
  reminderDays: number
  themeGender: string
  isLoggedIn: true
}

function readUser(): IAppUser | null {
  const openid = getCachedOpenid()
  const cached = getCachedUser()
  if (!openid || !cached) return null
  return { ...cached, openid, isLoggedIn: true }
}

export function getCurrentUser(): IAppUser | null {
  return readUser()
}

export function isLoggedIn(): boolean {
  return readUser() !== null
}

/** 建立或恢复微信身份；头像、昵称均为可选资料。 */
export async function loginWithProfile(profile: {
  avatarUrl?: string
  nickname?: string
} = {}): Promise<IAppUser> {
  const result = await login(profile)
  const user: IAppUser = {
    _id: result.user._id,
    openid: result.openid,
    nickname: result.user.nickname,
    avatarUrl: result.user.avatarUrl,
    gender: result.user.gender,
    tastePreference: result.user.tastePreference,
    dietaryRestrictions: result.user.dietaryRestrictions,
    difficultyLevel: result.user.difficultyLevel,
    reminderDays: result.user.reminderDays,
    themeGender: result.user.themeGender,
    isLoggedIn: true,
  }
  setCachedUser(user)
  return user
}

/** 仅在已有缓存时刷新（启动时静默调用） */
export async function refreshUser(): Promise<IAppUser | null> {
  if (!getCachedOpenid()) return null
  try {
    const result = await login()
    const user: IAppUser = {
      _id: result.user._id,
      openid: result.openid,
      nickname: result.user.nickname,
      avatarUrl: result.user.avatarUrl,
      gender: result.user.gender,
      tastePreference: result.user.tastePreference,
      dietaryRestrictions: result.user.dietaryRestrictions,
      difficultyLevel: result.user.difficultyLevel,
      reminderDays: result.user.reminderDays,
      themeGender: result.user.themeGender,
      isLoggedIn: true,
    }
    setCachedUser(user)
    return user
  } catch {
    return readUser()
  }
}

/** 路由守卫：未登录跳登录页（在 pageLifetimes.show 或 onLoad 调用） */
export function ensureLogin(): boolean {
  if (isLoggedIn()) return true
  wx.reLaunch({ url: '/pages/login/index' })
  return false
}

/**
 * 路由守卫：app.ts 启动时调用。
 * 未登录 → 延迟一帧 reLaunch 到登录页，避免和首页首次渲染抢帧造成闪屏。
 * 已登录 → 什么都不做。
 */
export function ensureLoginRoute(): void {
  if (isLoggedIn()) return
  setTimeout(() => {
    wx.reLaunch({ url: '/pages/login/index' })
  }, 80)
}

/** 退出登录 */
export function logout(): void {
  wx.removeStorageSync('_user_cache')
  wx.removeStorageSync('_openid_cache')
  wx.removeStorageSync('_last_sync_at')
  wx.removeStorageSync('_sync_queue_v1')
  wx.reLaunch({ url: '/pages/login/index' })
}

/** 拿用户显示名（fallback 用「小食光」） */
export function displayName(): string {
  const u = readUser()
  if (u?.nickname?.trim()) return u.nickname.trim()
  return '小食光'
}

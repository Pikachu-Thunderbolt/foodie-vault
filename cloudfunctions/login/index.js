// cloudfunctions/login/index.js
// 作用：根据 wx context 自动拿 openid，
//       在 users 集合里创建/更新用户档案（昵称/头像/性别/偏好）。
// 客户端调用：wx.cloud.callFunction({ name: 'login', data: { profile: { nickname, avatarUrl, gender } } })

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const USERS = 'users'

async function ensureUser(openid, profile) {
  const usersCol = db.collection(USERS)
  const existing = await usersCol.where({ _openid: openid }).limit(1).get()
  const now = new Date()

  // 默认档案
  const defaults = {
    tastePreference: 'any',
    dietaryRestrictions: [],
    difficultyLevel: 'any',
    reminderDays: 2,
    themeGender: '',
  }

  if (existing.data.length === 0) {
    const doc = {
      _openid: openid,
      // 身份建档不依赖微信头像和昵称；用户可进入后再自行完善。
      nickname: profile?.nickname || '厨房主人',
      avatarUrl: profile?.avatarUrl || '',
      gender: profile?.gender || '',
      ...defaults,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }
    const r = await usersCol.add({ data: doc })
    return { user: { ...doc, _id: r._id }, isNew: true }
  }

  const user = existing.data[0]
  const patch = { lastSeenAt: now, updatedAt: now }
  // 只在客户端传了对应字段时覆盖，避免空字符串覆盖已有值
  if (profile?.nickname) patch.nickname = profile.nickname
  if (profile?.avatarUrl) patch.avatarUrl = profile.avatarUrl
  if (profile?.gender) patch.gender = profile.gender

  await usersCol.doc(user._id).update({ data: patch })
  return { user: { ...user, ...patch }, isNew: false }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { code: -1, msg: 'missing openid' }

  try {
    const { user, isNew } = await ensureUser(openid, event.profile || {})
    return {
      code: 0,
      data: {
        openid,
        isNew,
        user: {
          _id: user._id,
          nickname: user.nickname || '',
          avatarUrl: user.avatarUrl || '',
          gender: user.gender || '',
          tastePreference: user.tastePreference || 'any',
          dietaryRestrictions: user.dietaryRestrictions || [],
          difficultyLevel: user.difficultyLevel || 'any',
          reminderDays: user.reminderDays ?? 2,
          themeGender: user.themeGender || '',
        },
      },
    }
  } catch (err) {
    console.error('[login] failed', err)
    return { code: -1, msg: err.message || 'login failed' }
  }
}

// utils/notify.ts - 消息提醒工具

// 请求消息订阅授权
export function requestNotificationPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [''],
      success() {
        resolve(true)
      },
      fail() {
        resolve(false)
      },
    })
  })
}

// 检查是否有未读提醒
export function checkExpiringReminders(): {
  count: number
  items: { name: string; daysLeft: number }[]
} {
  const { getExpiringIngredients } = require('./storage')
  const expiring = getExpiringIngredients(3)
  const now = new Date()

  const items = expiring.map((item: any) => {
    const expiry = new Date(item.expiryDate)
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    return { name: item.name, daysLeft }
  })

  return { count: items.length, items }
}

// 预设食材保质期（天数）
export const DEFAULT_EXPIRY_DAYS: Record<string, number> = {
  绿叶蔬菜: 3,
  根茎蔬菜: 14,
  菌菇类: 5,
  水果: 7,
  猪肉: 180,
  牛肉: 180,
  鸡肉: 90,
  鱼: 2,
  虾: 2,
  蛋: 30,
  牛奶: 7,
  酸奶: 14,
  豆腐: 3,
  调料: 365,
  主食: 180,
  干货: 365,
  冷冻食品: 90,
  其他: 7,
}

// 根据分类名获取默认保质天数
export function getDefaultExpiryDays(categoryName: string): number {
  return DEFAULT_EXPIRY_DAYS[categoryName] || 7
}

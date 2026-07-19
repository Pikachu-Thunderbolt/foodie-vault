// 标准菜品主视觉：所有列表、推荐与详情只使用该层图片，避免以食材图代替菜品。
const RECIPE_IMAGE_ALIASES: Record<string, string> = {
  '番茄炒蛋': '西红柿炒鸡蛋',
  '蛋炒西红柿': '西红柿炒鸡蛋',
  '青椒肉丝': '青椒炒肉丝',
  '蒜蓉西兰花': '蒜蓉西兰花',
  '干煸四季豆': '干煸豆角',
  '香菇滑鸡': '香菇炖鸡',
  '蒸水蛋': '家常蒸蛋',
  '鸡蛋炒饭': '蛋炒饭',
  '蛋炒韭菜': '韭菜炒鸡蛋',
  '蛋包饭': '蛋炒饭',
  '葱油拌面': '炒面',
  '炒豆芽': '清炒小白菜',
  '清炒时蔬': '清炒小白菜',
}

export function getRecipeImagePath(name: string, coverUrl = ''): string {
  if (coverUrl) return coverUrl
  const fileName = RECIPE_IMAGE_ALIASES[name] || name
  return `/resource/recipe-icon/${fileName}.png`
}

export function getRecipeImageForPage(name: string, coverUrl = ''): string {
  return `../../${getRecipeImagePath(name, coverUrl).replace(/^\//, '')}`
}

import { resolveFoodMatch } from './storage'

// 规范食材名 → 图片路径映射。有图片的食材使用手绘素材，没有的回退到 emoji。

const FOOD_IMAGE_MAP: Record<string, string> = {
  '番茄': '/resource/food-icon/番茄.png',
  '西红柿': '/resource/food-icon/番茄.png',
  '鸡蛋': '/resource/food-icon/鸡蛋.png',
  '鸭蛋': '/resource/food-icon/鸡蛋.png',
  '西兰花': '/resource/food-icon/西兰花.png',
  '花菜': '/resource/food-icon/花菜.png',
  '菜花': '/resource/food-icon/花菜.png',
  '黄瓜': '/resource/food-icon/黄瓜.png',
  '苦瓜': '/resource/food-icon/苦瓜.png',
  '丝瓜': '/resource/food-icon/丝瓜.png',
  '茄子': '/resource/food-icon/茄子.png',
  '土豆': '/resource/food-icon/土豆:马铃薯.png',
  '马铃薯': '/resource/food-icon/土豆:马铃薯.png',
  '洋葱': '/resource/food-icon/洋葱.png',
  '白萝卜': '/resource/food-icon/sticker/白萝卜.webp',
  '胡萝卜': '/resource/food-icon/胡萝卜.png',
  '山药': '/resource/food-icon/山药.png',
  '莴苣': '/resource/food-icon/莴苣.png',
  '冬瓜': '/resource/food-icon/sticker/冬瓜.webp',
  '南瓜': '/resource/food-icon/南瓜.png',
  '大白菜': '/resource/food-icon/sticker/大白菜.webp',
  '白菜': '/resource/food-icon/sticker/大白菜.webp',
  '包菜': '/resource/food-icon/sticker/大白菜.webp',
  '上海青': '/resource/food-icon/上海青.png',
  '青菜': '/resource/food-icon/上海青.png',
  '生菜': '/resource/food-icon/油麦菜.png',
  '菠菜': '/resource/food-icon/菠菜.png',
  '芹菜': '/resource/food-icon/芹菜.png',
  '油麦菜': '/resource/food-icon/油麦菜.png',
  '青椒': '/resource/food-icon/青椒.png',
  '彩椒': '/resource/food-icon/彩椒.png',
  '五花肉': '/resource/food-icon/五花肉.png',
  '猪肉': '/resource/food-icon/五花肉.png',
  '猪肉馅': '/resource/food-icon/五花肉.png',
  '鸡肉': '/resource/food-icon/sticker/鸡肉-clean.png',
  '鸡胸肉': '/resource/food-icon/sticker/鸡肉-clean.png',
  '鸡腿肉': '/resource/food-icon/sticker/鸡肉-clean.png',
  '牛奶': '/resource/food-icon/sticker/牛奶-新版.png',
  '酸奶': '/resource/food-icon/sticker/酸奶-新版.png',
  '豆浆': '/resource/food-icon/sticker/牛奶盒.webp',
  '奶油': '/resource/food-icon/sticker/牛奶盒.webp',
  '芝士片': '/resource/food-icon/奶酪.png',
  '奶酪': '/resource/food-icon/奶酪.png',
  '虾仁': '/resource/food-icon/sticker/虾仁.webp',
  '虾': '/resource/food-icon/虾.png',
  '三文鱼': '/resource/food-icon/三文鱼.png',
  '食盐': '/resource/food-icon/食盐.png',
  '盐': '/resource/food-icon/食盐.png',
  '牛油果': '/resource/food-icon/sticker/牛油果-clean.png',
  '鳄梨': '/resource/food-icon/sticker/牛油果-clean.png',
  '豆腐': '/resource/food-icon/sticker/豆腐-clean.png',
}

export interface FoodVisual {
  type: 'image' | 'emoji'
  value: string
}

export function getFoodVisual(name: string, fallbackEmoji: string): FoodVisual {
  const match = resolveFoodMatch(name)
  const canonicalName = match.canonicalName || name
  if (FOOD_IMAGE_MAP[canonicalName]) {
    return { type: 'image', value: getStickerPath(FOOD_IMAGE_MAP[canonicalName]) }
  }
  // 低置信度时仍保留原有包含匹配作为展示兜底，但不回写规范名。
  for (const [key, path] of Object.entries(FOOD_IMAGE_MAP)) {
    if (canonicalName.includes(key) || key.includes(canonicalName)) {
      return { type: 'image', value: getStickerPath(path) }
    }
  }
  return { type: 'emoji', value: fallbackEmoji }
}

function getStickerPath(path: string): string {
  return path.includes('/resource/food-icon/sticker/')
    ? path
    : path.replace('/resource/food-icon/', '/resource/food-icon/sticker/')
}

'use strict'
const cloud = require('wx-server-sdk')
const ingredients = require('../data/food-dictionary.seed.json')
const dishes = require('../data/dish-dictionary.seed.json')
cloud.init({ env: process.env.CLOUDBASE_ENV || cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
async function upsert(collection, item) {
  const found = await db.collection(collection).where({ dictionaryId: item.dictionaryId }).limit(1).get()
  const data = { ...item, updatedAt: new Date() }
  return found.data[0] ? db.collection(collection).doc(found.data[0]._id).update({ data }) : db.collection(collection).add({ data: { ...data, createdAt: new Date() } })
}
async function main() {
  for (const item of ingredients) await upsert('food_dictionary', item)
  for (const item of dishes) await upsert('dish_dictionary', item)
  console.log(`seeded ${ingredients.length} ingredients and ${dishes.length} dishes`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })

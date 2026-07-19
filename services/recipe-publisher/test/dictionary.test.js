'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs/promises')
const { createLocalCloud } = require('../src/local-cloud')
const { RecipePublisher } = require('../src/publisher')

test('listDictionaryQueue returns pending items for the dashboard', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-dict-'))
  const cloud = createLocalCloud(root)
  const publisher = new RecipePublisher({ cloud, ingestRoot: root })
  const db = cloud.database()
  await db.collection('dictionary_review_queue').add({ data: { queueKey: 'ingredient:番茄', dictionaryKind: 'ingredient', rawName: '番茄', status: 'PENDING', updatedAt: new Date() } })
  await db.collection('dictionary_review_queue').add({ data: { queueKey: 'dish:红烧肉', dictionaryKind: 'dish', rawName: '红烧肉', status: 'RESOLVED', updatedAt: new Date() } })
  const pending = await publisher.listDictionaryQueue('PENDING')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].rawName, '番茄')
})

test('resolveDictionaryQueue creates a canonical entry and marks item resolved', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paoding-dict-'))
  const cloud = createLocalCloud(root)
  const publisher = new RecipePublisher({ cloud, ingestRoot: root })
  const db = cloud.database()
  const added = await db.collection('dictionary_review_queue').add({ data: { queueKey: 'ingredient:小葱', dictionaryKind: 'ingredient', rawName: '小葱', status: 'PENDING', updatedAt: new Date() } })
  const result = await publisher.resolveDictionaryQueue(added._id, { action: 'create_new', canonicalName: '葱', category: '香辛料', reviewer: 'admin' })
  assert.equal(result.canonicalName, '葱')
  assert.ok(result.aliases.includes('小葱'))
  const remaining = await publisher.listDictionaryQueue('PENDING')
  assert.equal(remaining.length, 0)
})

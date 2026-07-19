'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ValidationError, validateManifest, isSafeRelativePath } = require('../src/validator')

const hash = 'a'.repeat(64)
const base = () => ({
  schemaVersion: '1.0', packageId: 'pkg-001', contentHash: hash,
  producer: { systemName: 'processor', jobId: 'job-001' },
  source: { contentType: 'video', platform: 'demo', sourceContentId: 'source-001', sourceUrl: 'https://example.com/1', rightsStatus: 'cleared', durationSeconds: 30 },
  recipe: { recipeName: '番茄炒蛋', coverAssetId: 'asset-cover', reviewRequired: true },
  mediaAssets: [{ assetId: 'asset-cover', localRelativePath: 'media/cover.webp', sha256: hash, mimeType: 'image/webp', byteSize: 1, width: 1, height: 1, role: 'cover' }],
  ingredients: [{ ingredientRef: 'ing-1', rawName: '番茄', role: 'core', isOptional: false, normalizationStatus: 'candidate', evidenceRefs: ['ev-1'] }],
  steps: [{ stepNo: 1, instruction: '切番茄', sourceTimeStartSeconds: 0, sourceTimeEndSeconds: 4, evidenceRefs: ['ev-1'] }],
  quality: { evidence: [{ evidenceId: 'ev-1' }] },
  processingStage: 'EXTRACTED',
  unresolvedFields: [{ fieldPath: 'recipe.canonicalDishId', reasonCode: 'MISSING_DICTIONARY', nextOwner: 'dictionary', blockingPublish: true }],
})

test('accepts a complete minimum manifest', () => assert.equal(validateManifest(base()).packageId, 'pkg-001'))
test('rejects traversal paths', () => {
  const manifest = base()
  manifest.mediaAssets[0].localRelativePath = '../secret.webp'
  assert.throws(() => validateManifest(manifest), ValidationError)
  assert.equal(isSafeRelativePath('media/cover.webp'), true)
  assert.equal(isSafeRelativePath('../cover.webp'), false)
})
test('rejects missing source time for a video step', () => {
  const manifest = base()
  delete manifest.steps[0].sourceTimeEndSeconds
  assert.throws(() => validateManifest(manifest), ValidationError)
})
test('rejects PUBLISH_READY without canonical data and cleared rights', () => {
  const manifest = base()
  manifest.processingStage = 'PUBLISH_READY'
  assert.throws(() => validateManifest(manifest), ValidationError)
})

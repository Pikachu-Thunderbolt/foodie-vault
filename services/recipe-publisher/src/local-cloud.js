'use strict'

// 仅用于无网络、本机预览 Dashboard 的持久化替身；云托管环境仍使用 wx-server-sdk。
const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

function matches(doc, query) { return Object.entries(query || {}).every(([key, value]) => doc[key] === value) }

function createLocalCloud(root) {
  const dbFile = path.join(root, 'local-cloud-db.json')
  const storageRoot = path.join(root, 'local-cloud-storage')
  async function read() { try { return JSON.parse(await fs.readFile(dbFile, 'utf8')) } catch (_) { return {} } }
  async function write(data) { await fs.mkdir(root, { recursive: true }); await fs.writeFile(dbFile, `${JSON.stringify(data, null, 2)}\n`) }
  function collection(name) {
    let query = null; let offset = 0; let maximum = Infinity; let order = null
    const api = {
      where(value) { query = value; return api }, skip(value) { offset = value; return api }, limit(value) { maximum = value; return api }, orderBy(field, direction) { order = { field, direction }; return api },
      async get() { const data = await read(); let rows = (data[name] || []).filter((item) => matches(item, query)); if (order) rows.sort((a, b) => (a[order.field] > b[order.field] ? 1 : -1) * (order.direction === 'desc' ? -1 : 1)); return { data: rows.slice(offset, offset + maximum) } },
      async add({ data: value }) { const data = await read(); const id = crypto.randomUUID(); data[name] = data[name] || []; data[name].push({ ...value, _id: id }); await write(data); return { _id: id } },
      doc(id) { return {
        async get() { const data = await read(); const value = (data[name] || []).find((item) => item._id === id); if (!value) throw new Error('document not found'); return { data: value } },
        async update({ data: patch }) { const data = await read(); const rows = data[name] || []; const index = rows.findIndex((item) => item._id === id); if (index < 0) throw new Error('document not found'); rows[index] = { ...rows[index], ...patch }; await write(data); return { updated: 1 } },
      } },
    }
    return api
  }
  return {
    init() {}, database: () => ({ collection }),
    localStorageRoot: storageRoot,
    async uploadFile({ cloudPath, fileContent }) { const target = path.join(storageRoot, cloudPath); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, fileContent); return { fileID: `local://${cloudPath}` } },
    // 本地假云的临时 URL：指向 Node 的 /__localmedia 路由（server.js 从 storageRoot 读文件）。
    async getTempFileURL({ fileList }) {
      return { fileList: (fileList || []).map((fileID) => ({ fileID, tempFileURL: `/__localmedia/${String(fileID).replace(/^local:\/\//, '')}`, status: 0 })) }
    },
  }
}

module.exports = { createLocalCloud }

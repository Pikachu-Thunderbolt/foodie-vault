'use strict'

const channels = {}

function register(adapter) {
  channels[adapter.channelType] = adapter
}

function getChannel(channelType) {
  const ch = channels[channelType]
  if (!ch) throw new Error(`Unknown channel: ${channelType}`)
  return ch
}

function listChannels() {
  return Object.values(channels).map(ch => ({
    channelType: ch.channelType,
    label: ch.label,
  }))
}

// 便捷方法：委托到对应渠道
function parseSourceId(channelType, input) {
  return getChannel(channelType).parseSourceId(input)
}
function buildSourceUrl(channelType, sourceId) {
  return getChannel(channelType).buildSourceUrl(sourceId)
}
function evaluateCookingTutorial(channelType, sourceMeta) {
  return getChannel(channelType).evaluateCookingTutorial(sourceMeta)
}
function getDiscoveryModes(channelType) {
  return getChannel(channelType).discovery.modes
}
function getDiscoveryConfig(channelType) {
  return getChannel(channelType).discovery
}

// 自注册
register(require('./bilibili'))

module.exports = { register, getChannel, listChannels, parseSourceId, buildSourceUrl, evaluateCookingTutorial, getDiscoveryModes, getDiscoveryConfig }

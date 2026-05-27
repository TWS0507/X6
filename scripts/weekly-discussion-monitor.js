#!/usr/bin/env node
/* eslint-disable no-console */

const DEFAULT_SHEET_ID = '1bBm123CIEiLSpLHmiEXvzX0AehFUWBc68UERpUyqPok'
const DEFAULT_GID = '1710171904'

function getArgs() {
  const args = process.argv.slice(2)
  const map = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=')
      const next = value == null ? args[i + 1] : value
      if (value == null && next && !next.startsWith('--')) {
        map[key.slice(2)] = next
        i += 1
      } else {
        map[key.slice(2)] = value == null ? true : value
      }
    }
  }
  return map
}

function getUtc8Day() {
  const now = new Date()
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return utc8.getUTCDay()
}

function isCheckDay(day) {
  return day === 2 || day === 4
}

async function fetchSheetValues({ apiKey, sheetId, range }) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`)
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Sheets API error (${res.status}): ${text}`)
  }

  const json = await res.json()
  return json.values || []
}

function parseRows(rows) {
  if (rows.length < 2) {
    return { headers: [], missing: [] }
  }

  const headers = rows[0]
  const nameIndex = 0
  const discussionIndex = headers.findIndex((h) => /discussion/i.test(String(h)))
  const replyIndex = headers.findIndex((h) => /reply/i.test(String(h)))

  if (discussionIndex === -1 || replyIndex === -1) {
    throw new Error('未找到包含 discussion/reply 的列，请确认表头名称。')
  }

  const missing = []

  rows.slice(1).forEach((row, i) => {
    const name = row[nameIndex] || `未命名成员#${i + 1}`
    const discussion = String(row[discussionIndex] || '').trim()
    const reply = String(row[replyIndex] || '').trim()
    const discussionOk = discussion.includes('✅')
    const replyOk = reply.includes('✅')

    if (!discussionOk || !replyOk) {
      missing.push({
        name,
        discussionOk,
        replyOk,
      })
    }
  })

  return { headers, missing }
}

function buildLarkText({ missing, sheetId, gid }) {
  if (!missing.length) {
    return '✅ 本周所有组员都已完成 discussion 和 reply。'
  }

  const lines = [
    '⚠️ 以下组员还未完成本周任务，请尽快补齐：',
    ...missing.map((m) => {
      const tasks = []
      if (!m.discussionOk) tasks.push('discussion')
      if (!m.replyOk) tasks.push('reply')
      return `- ${m.name}: 缺少 ${tasks.join(' + ')}`
    }),
    '',
    `Google Sheet: https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${gid}`,
  ]

  return lines.join('\n')
}

async function sendToLark({ webhook, text }) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'text',
      content: { text },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Lark webhook error (${res.status}): ${body}`)
  }
}

async function main() {
  const args = getArgs()

  const apiKey = args['google-api-key'] || process.env.GOOGLE_API_KEY
  const sheetId = args['sheet-id'] || process.env.SHEET_ID || DEFAULT_SHEET_ID
  const gid = args.gid || process.env.SHEET_GID || DEFAULT_GID
  const range = args.range || process.env.SHEET_RANGE || 'Sheet1!A1:Z'
  const webhook = args['lark-webhook'] || process.env.LARK_WEBHOOK
  const force = args.force === 'true' || args.force === true

  if (!apiKey) {
    throw new Error('缺少 Google API Key，请设置 GOOGLE_API_KEY 或 --google-api-key。')
  }

  const day = getUtc8Day()
  if (!force && !isCheckDay(day)) {
    console.log('今天不是周二或周四（按 UTC+8 计算），跳过提醒。')
    return
  }

  const rows = await fetchSheetValues({ apiKey, sheetId, range })
  const { missing } = parseRows(rows)
  const text = buildLarkText({ missing, sheetId, gid })

  if (!webhook) {
    console.log('Lark webhook 尚未提供，先输出消息预览：\n')
    console.log(text)
    return
  }

  await sendToLark({ webhook, text })
  console.log('已发送提醒到 Lark。')
}

main().catch((error) => {
  console.error(`执行失败: ${error.message}`)
  process.exit(1)
})

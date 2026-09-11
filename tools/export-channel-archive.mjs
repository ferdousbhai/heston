// Walk the public preview of the retired channel and print one JSON line per post, oldest
// first: {id, postedAt, html}.
//   node tools/export-channel-archive.mjs > channel.jsonl
const CHANNEL = 'longvolatility'
const PAGE_PAUSE_MS = 400
const out = new Map()
let before
for (;;) {
  const url = `https://t.me/s/${CHANNEL}${before ? `?before=${before}` : ''}`
  // An empty page is how the walk ends, so a refusal must throw rather than read as the end.
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!response.ok) throw new Error(`Channel page refused (${response.status})`)
  const html = await response.text()
  const blocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|<\/section>)/g)].map((m) => m[0])
  let lowest = Number.POSITIVE_INFINITY
  for (const block of blocks) {
    const id = Number(block.match(/data-post="[^"/]+\/(\d+)"/)?.[1])
    const postedAt = block.match(/<time datetime="([^"]+)"/)?.[1]
    if (!id || !postedAt) continue
    lowest = Math.min(lowest, id)
    if (block.includes('tgme_widget_service_strong_text')) continue
    const text = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
    if (text) out.set(id, { html: text, id, postedAt })
  }
  if (!Number.isFinite(lowest) || (before !== undefined && lowest >= before)) break
  before = lowest
  await new Promise((resolve) => setTimeout(resolve, PAGE_PAUSE_MS))
}
for (const post of [...out.values()].sort((a, b) => a.id - b.id)) console.log(JSON.stringify(post))
console.error(`exported ${out.size} posts`)

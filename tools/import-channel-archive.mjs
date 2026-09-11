// Turn the exported channel posts into plain text plus links, and load them into D1.
//   node tools/import-channel-archive.mjs channel.jsonl > channel.sql
//   npx wrangler d1 execute spice-production --remote --file channel.sql
// Telegram's markup never reaches the store: tags are dropped, breaks become newlines, and
// every link the post carried is kept as a bare HTTPS URL.
import { readFile } from 'node:fs/promises'
const [,, file] = process.argv
const ENTITIES = { '&amp;': '&', '&gt;': '>', '&lt;': '<', '&nbsp;': ' ', '&quot;': '"' }
const unescape = (s) => s.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&(?:amp|gt|lt|nbsp|quot);/g, (m) => ENTITIES[m])
// Telegram's own auto-delete notice is not a post anyone wrote.
const NOTICE = 'Messages in this channel will be automatically deleted after 1 month'
const rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
const statements = []
const importedAt = new Date().toISOString()
for (const { html, id, postedAt } of rows) {
  const links = [...new Set([...html.matchAll(/href="(https:\/\/[^"]+)"/g)].map((m) => unescape(m[1])))]
  const text = unescape(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').trim()
  if (!text || text === NOTICE) continue
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  statements.push(`INSERT OR REPLACE INTO long_vol_channel_posts (post_id, posted_at, text, links_json, imported_at) VALUES (${id}, ${q(new Date(postedAt).toISOString())}, ${q(text)}, ${q(JSON.stringify(links))}, ${q(importedAt)});`)
}
console.log(statements.join('\n'))
console.error(`${statements.length} posts`)

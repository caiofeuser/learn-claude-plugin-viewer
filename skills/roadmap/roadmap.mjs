/**
 * roadmap.sh without a browser: the public endpoint gives each roadmap's drawing,
 * the official content repo gives each topic's curated notes and resources.
 *
 *   node roadmap.mjs                    every roadmap slug
 *   node roadmap.mjs find <words>       topics matching all the words, across every roadmap
 *   node roadmap.mjs <slug>             the main path in order, then every box with its position
 *   node roadmap.mjs <slug> <id>...     curated notes and resources for those topic ids
 */

const API = "https://roadmap.sh/api/v1-official-roadmap/"
const REPO = "https://api.github.com/repos/nilbuild/developer-roadmap"
const RAW = "https://raw.githubusercontent.com/nilbuild/developer-roadmap/master/"

async function get(url, as = "json") {
  const res = await fetch(url, { headers: { "User-Agent": "learn-plugin" } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res[as]()
}

async function list() {
  const dirs = await get(`${REPO}/contents/roadmaps`)
  console.log(dirs.map((d) => d.name).join("\n"))
}

async function find(words) {
  const tree = await get(`${REPO}/git/trees/master?recursive=1`)
  const hits = tree.tree
    .map((e) => /^roadmaps\/([^/]+)\/content\/(.+)@([^@/]+)\.md$/.exec(e.path))
    .filter((m) => m && words.every((w) => m[2].includes(w.toLowerCase())))
  if (!hits.length) return console.log(`No roadmap topic matches "${words.join(" ")}".`)
  for (const [, slug, name, id] of hits.slice(0, 40)) console.log(`${slug.padEnd(28)} ${id}  ${name.replace(/-+/g, " ")}`)
  if (hits.length > 40) console.log(`… ${hits.length - 40} more; add a word to narrow it.`)
}

// A roadmap is a drawing, not a tree: only the main path has a reliable order, so the
// grouping of subtopics is left to the reader, with positions to go on.
async function show(slug) {
  const roadmap = await get(API + slug)
  const at = (n) => n.positionAbsolute ?? n.position ?? { x: 0, y: 0 }
  const label = (n) => String(n.data?.label ?? "").replace(/\s+/g, " ").trim()
  const boxes = roadmap.nodes
    .filter((n) => ["topic", "subtopic", "label"].includes(n.type) && label(n))
    .sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x)

  console.log(`# ${roadmap.title?.page ?? roadmap.title} (https://roadmap.sh/${slug})\n\n${roadmap.description ?? ""}\n`)
  console.log("Main path, top to bottom (topics on the same row, left to right):")
  boxes.filter((n) => n.type === "topic").forEach((n, i) => console.log(`${i + 1}. ${label(n)}  [${n.id}]`))
  console.log("\nEvery box, top to bottom. y and x are positions in the drawing: boxes close together belong together, and a label names the group next to it.")
  console.log("     y      x  type      name")
  for (const n of boxes) {
    const [y, x] = [at(n).y, at(n).x].map((v) => String(Math.round(v)).padStart(6))
    console.log(`${y} ${x}  ${n.type.padEnd(8)}  ${label(n)}${n.type === "label" ? "" : `  [${n.id}]`}`)
  }
  console.log(`\nNotes and resources for any topic: node roadmap.mjs ${slug} <id> [<id>...]`)
}

async function notes(slug, ids) {
  const files = await get(`${REPO}/contents/roadmaps/${slug}/content`)
  for (const id of ids) {
    const file = files.find((f) => f.name.endsWith(`@${id}.md`))
    console.log(file ? (await get(RAW + file.path, "text")).trim() : `No notes for topic id ${id} in ${slug}.`)
    console.log("\n---\n")
  }
}

const [first, ...rest] = process.argv.slice(2)
try {
  if (!first) await list()
  else if (first === "find") await find(rest)
  else if (rest.length) await notes(first, rest)
  else await show(first)
} catch (err) {
  console.error(`roadmap: ${err.message}`)
  process.exit(1)
}

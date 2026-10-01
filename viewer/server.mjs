// learn viewer: this plugin's MCP server (tools ask, quiz, render) and the lesson page it serves.
// No dependencies: MCP over stdio is newline-delimited JSON-RPC, small enough to speak directly.

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { json } from "node:stream/consumers"
import { fileURLToPath } from "node:url"

// ponytail: one fixed port per session; a second concurrent session needs its own LEARN_PORT.
const PORT = Number(process.env.LEARN_PORT) || 4747
const VIEWER_URL = `http://127.0.0.1:${PORT}`
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html")
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((p) => p && fs.existsSync(p))
// The npx next to this node, in case Claude Code passed a thin PATH.
const NPX_BESIDE_NODE = path.join(path.dirname(process.execPath), "npx")
const NPX = fs.existsSync(NPX_BESIDE_NODE) ? NPX_BESIDE_NODE : "npx"

const log = (...args) => process.stderr.write(`[learn] ${args.join(" ")}\n`)
let projectDir = process.cwd()

const items = new Map() // key → item, in page order
const clients = new Set() // open SSE responses

function upsert(item) {
  items.set(item.key, item)
  broadcast({ op: "upsert", item })
}

function broadcast(msg) {
  const frame = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of clients) res.write(frame)
}

let transcript = null
let size = 0 // bytes seen last pass
let done = 0 // complete lines already ingested
const toolUses = new Map() // tool_use id → { name, input }

function follow(file) {
  transcript = file
  size = done = 0
  toolUses.clear()
  items.clear()
  broadcast({ op: "reset", items: [] })
  sync()
}

// ponytail: re-reads the whole transcript each time it grows; tail by byte offset if files reach tens of MB.
function sync() {
  try {
    if (!transcript || !fs.existsSync(transcript)) return
    const now = fs.statSync(transcript).size
    if (now === size) return
    size = now
    // The last piece is empty, or a line Claude Code is still writing.
    const lines = fs.readFileSync(transcript, "utf8").split("\n").slice(done, -1)
    done += lines.length
    for (const line of lines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      ingest(entry)
    }
  } catch (err) {
    log("transcript sync failed:", err.stack ?? err)
  }
}
setInterval(sync, 400)

function ingest(e) {
  if (e.isSidechain || e.isMeta || e.isCompactSummary) return
  const content = e.message?.content ?? []
  if (e.type === "assistant") {
    for (const [i, block] of content.entries()) {
      if (block.type === "text" && block.text.trim()) {
        upsert({ key: `${e.uuid}:${i}`, kind: "assistant", text: block.text })
      }
      if (block.type === "tool_use") toolUses.set(block.id, { name: block.name, input: block.input ?? {} })
    }
  } else if (e.type === "user") {
    if (typeof content === "string") return onUserText(e.uuid, content)
    for (const [i, block] of content.entries()) {
      if (block.type === "text") onUserText(`${e.uuid}:${i}`, block.text)
      if (block.type === "tool_result") onToolResult(block)
    }
  }
}

function onUserText(key, raw) {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(raw)
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1] ?? ""
  const text = command
    ? `${command[1]} ${args}`.trim()
    : raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
  if (!text || /^<(local-command|bash-)/.test(text) || text.startsWith("[Request interrupted")) return
  upsert({ key, kind: "user", text })
}

// Live cards are already on the page; this only fills in past ones, e.g. after --resume.
function onToolResult(block) {
  const use = toolUses.get(block.tool_use_id)
  if (!use || !/^mcp__.*__(quiz|ask)$/.test(use.name)) return
  const text = textOf(block.content)
  const id = /^\[(?:quiz|ask) ([\w-]+)\]/.exec(text)?.[1]
  if (id && items.has(`live:${id}`)) return
  upsert({
    key: `live:${id ?? block.tool_use_id}`,
    kind: "replay",
    tag: use.name.endsWith("__quiz") ? "Quiz" : "Question",
    question: String(use.input.question ?? ""),
    text,
  })
}

function textOf(content) {
  if (typeof content === "string") return content
  return (content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
}

let autoOpened = false

function onHook(hook, pid) {
  // A second session can't bind the port, but its hooks would still land here.
  if (pid && Number(pid) !== process.ppid) return
  if (typeof hook.cwd === "string" && hook.cwd) projectDir = hook.cwd
  const file = hook.transcript_path
  if (typeof file === "string" && file.endsWith(".jsonl") && file !== transcript) follow(file)
  // Give an already-open tab time to reconnect before opening another.
  setTimeout(() => {
    if (clients.size || autoOpened) return
    autoOpened = true
    openViewer()
  }, 1500)
}

function openViewer() {
  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  spawn(opener, [VIEWER_URL], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref()
}

const waiting = new Map() // card id → { item, options, requestId, finish, ...grading }

// Resolves with the tool result once the card is answered, or null if it was cancelled.
async function showCard(card, requestId, grading = {}) {
  if (!listening) {
    throw new Error(
      `The lesson viewer isn't running: port ${PORT} is taken (another learn session?). ` +
        "Restart Claude Code with LEARN_PORT set to a free port.",
    )
  }
  // Let the transcript catch up so the text leading into the card lands above it.
  await new Promise((r) => setTimeout(r, 300))
  sync()

  const id = randomUUID().slice(0, 8)
  const item = {
    key: `live:${id}`,
    kind: card.kind,
    id,
    status: "pending",
    question: String(card.args.question ?? ""),
    details: String(card.args.details ?? "").trim() || undefined,
    multi: card.args.multiSelect === true,
    options: card.options.map((o, i) => ({ index: i + 1, label: o.label, description: o.description })),
  }
  upsert(item)
  if (!clients.size) openViewer()
  return new Promise((finish) => {
    waiting.set(id, { item, options: card.options, requestId, finish, ...grading })
  })
}

async function quiz(args, requestId) {
  let options = normalizeOptions(args.options)
  if (options.length < 2) throw new Error("quiz requires at least two options.")
  // Shuffle before resolving the key, so grading matches the order on screen.
  if (args.shuffle !== false) options = shuffle(options)
  const correct = resolveCorrect(args.correctAnswer, options)
  const explanation = String(args.explanation ?? "").trim()
  return showCard({ kind: "quiz", args, options }, requestId, { correct, explanation })
}

async function ask(args, requestId) {
  return showCard({ kind: "question", args, options: normalizeOptions(args.options) }, requestId)
}

// Returns an error message for the page, or nothing when the answer is accepted.
function answer(body) {
  const w = waiting.get(body.id)
  if (!w || w.item.status !== "pending") return "This question is no longer waiting for an answer."
  const selected = Array.isArray(body.selected) ? body.selected : []
  const picks = body.dontKnow ? [] : [...new Set(selected.map(Number))].sort((a, b) => a - b)
  if (picks.some((n) => !Number.isInteger(n) || n < 1 || n > w.options.length)) return "That option doesn't exist."
  if (!w.item.multi && picks.length > 1) return "Pick exactly one option."
  const text = (field) => (typeof body[field] === "string" && body[field].trim()) || undefined

  if (w.item.kind === "question") {
    const written = text("text")
    if (!picks.length && !written) return "Pick an option or type an answer."
    w.item = { ...w.item, status: "answered", result: { selected: picks, text: written } }
    upsert(w.item)
    return w.finish(askResult(w))
  }

  if (!body.dontKnow && !picks.length) return "Pick at least one option."
  const isCorrect = !body.dontKnow && picks.length === w.correct.length && picks.every((n, i) => n === w.correct[i])
  const result = {
    selected: picks,
    correct: w.correct,
    isCorrect,
    dontKnow: body.dontKnow === true,
    note: text("note"),
    explanation: w.explanation,
  }
  w.item = { ...w.item, status: "answered", result }
  upsert(w.item)
  w.finish(quizResult(w))
}

function askResult({ item, options }) {
  const { selected, text } = item.result
  const lines = [`[ask ${item.id}] User answered.`]
  if (selected.length) lines.push(`Selected: ${selected.map((n) => `${n}. ${options[n - 1].label}`).join(", ")}`)
  if (text) lines.push(`${selected.length ? "Also wrote" : "Answer"}: ${text}`)
  return { content: [{ type: "text", text: lines.join("\n") }] }
}

function quizResult({ item, options, correct, explanation }) {
  const { selected, dontKnow, isCorrect, note } = item.result
  const ref = (n) => `${n}. ${options[n - 1].label}`
  const verdict = dontKnow
    ? `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`
    : `User answered ${isCorrect ? "correctly" : "incorrectly"}.`
  const lines = [`[quiz ${item.id}] ${verdict}`]
  if (!dontKnow) lines.push(`Selected: ${selected.map(ref).join(", ")}`)
  lines.push(`Correct: ${correct.map(ref).join(", ")}`)
  if (note) lines.push(`User's note: ${note}`)
  if (explanation) lines.push(`Explanation: ${explanation}`)
  return { content: [{ type: "text", text: lines.join("\n") }] }
}

function cancel(requestId) {
  for (const w of waiting.values()) {
    if (w.requestId !== requestId || w.item.status !== "pending") continue
    w.item = { ...w.item, status: "cancelled" }
    upsert(w.item)
    w.finish(null) // MCP: a cancelled request gets no response
  }
}

function normalizeOptions(raw) {
  const seen = new Set()
  const options = []
  for (const o of Array.isArray(raw) ? raw : []) {
    const label = String(o?.label ?? "").trim()
    if (!label) continue
    const value = String(o?.value ?? "").trim() || label
    if (seen.has(value)) throw new Error(`quiz: duplicate option value "${value}".`)
    seen.add(value)
    options.push({ label, value, description: String(o?.description ?? "").trim() || undefined })
  }
  return options
}

function shuffle(options) {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// Keyed by value, not position, so a typo is a hard error instead of a silently wrong grade.
function resolveCorrect(correctAnswer, options) {
  let values = correctAnswer
  // Multi-select keys sometimes arrive JSON-stringified ('["a","b"]').
  if (typeof values === "string" && /^\s*\[.*\]\s*$/s.test(values)) {
    try {
      values = JSON.parse(values)
    } catch {}
  }
  values = (Array.isArray(values) ? values : [values]).filter((v) => v != null).map((v) => String(v).trim())
  if (!values.length) throw new Error("quiz: correctAnswer is required.")

  const byValue = new Map(options.map((o, i) => [o.value, i + 1]))
  const indices = values.map((v) => {
    if (byValue.has(v)) return byValue.get(v)
    const known = options.map((o) => `"${o.value}"`).join(", ")
    throw new Error(`quiz: correctAnswer "${v}" matches no option value (${known}).`)
  })
  return [...new Set(indices)].sort((a, b) => a - b)
}

async function render({ format, source, save_as }) {
  const src = String(source ?? "").trim()
  if (!src) throw new Error("render requires a non-empty `source`.")
  if (format !== "mermaid" && format !== "svg") throw new Error('`format` must be "mermaid" or "svg".')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "learn-render-"))
  try {
    const out = path.join(work, "out.png")
    const run = await (format === "mermaid" ? renderMermaid : renderSvg)(src, work, out)
    if (!fs.existsSync(out)) {
      const detail = run.trim().split("\n").slice(-30).join("\n")
      const text = `Render FAILED, no image produced. Fix the source and call render again.\n\n${detail}`
      return { isError: true, content: [{ type: "text", text }] }
    }

    const png = fs.readFileSync(out)
    const image = { type: "image", data: png.toString("base64"), mimeType: "image/png" }
    if (!save_as) {
      const text =
        "Preview (not saved). LOOK: is every arrow, label, position and proportion correct? " +
        "Is anything cramped or clipped? Fix and render again, or call once more with `save_as` to publish."
      return { content: [{ type: "text", text }, image] }
    }

    const slug = String(save_as).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "viz"
    const filename = `viz-${slug}-${Date.now()}.png`
    const dest = path.join(projectDir, "viz", filename)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, png)
    const text = `Published.\nfilename: ${filename}\npath: ${dest}\n\nLOOK at the image once more to confirm it is correct.`
    return { content: [{ type: "text", text }, image] }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function renderMermaid(src, work) {
  fs.writeFileSync(path.join(work, "in.mmd"), src)
  // Point puppeteer at the installed Chrome so mermaid-cli never downloads Chromium.
  fs.writeFileSync(path.join(work, "puppeteer.json"), JSON.stringify(CHROME ? { executablePath: CHROME } : {}))
  const args = ["-y", "-p", "@mermaid-js/mermaid-cli@11", "mmdc"]
  args.push("-i", "in.mmd", "-o", "out.png", "-p", "puppeteer.json", "-s", "2", "-b", "white")
  return exec(NPX, args, work, { PUPPETEER_SKIP_DOWNLOAD: "1" })
}

function renderSvg(src, work, out) {
  if (!CHROME) throw new Error("SVG rendering needs Chrome. Set CHROME_PATH.")
  const file = path.join(work, "in.svg")
  fs.writeFileSync(file, src)
  const [w, h] = svgSize(src)
  const args = ["--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2"]
  args.push(`--window-size=${w},${h}`, `--screenshot=${out}`, `file://${file}`)
  return exec(CHROME, args, work)
}

// Chrome screenshots a fixed-size window, so size it to the SVG.
function svgSize(src) {
  const tag = /<svg\b[^>]*>/i.exec(src)?.[0] ?? ""
  const attr = (name) => Number(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(?:px)?\\s*["']`, "i").exec(tag)?.[1])
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag)
  const w = attr("width") || Number(box?.[1]) || 800
  const h = attr("height") || Number(box?.[2]) || 600
  return [Math.min(Math.ceil(w), 4000), Math.min(Math.ceil(h), 4000)]
}

// Resolves with everything the command printed, success or not.
function exec(cmd, args, cwd, env = {}) {
  const options = { cwd, env: { ...process.env, ...env }, timeout: 120_000, killSignal: "SIGKILL" }
  return new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout, stderr) => resolve(`${stdout}${stderr}${err?.message ?? ""}`))
  })
}

let listening = false

const server = http.createServer(async (req, res) => {
  // Guards against DNS rebinding: answer only requests addressed to this machine.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "")) return end(res, 403)
  const url = new URL(req.url, VIEWER_URL)
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return reply(res, 200, fs.readFileSync(PAGE), "text/html; charset=utf-8")
    }
    if (req.method === "GET" && url.pathname === "/events") return openStream(req, res)
    if (req.method === "GET" && url.pathname.startsWith("/viz/")) return serveViz(res, url.pathname)
    if (req.method === "POST") {
      // A JSON content type forces a CORS preflight, so other sites can't post here.
      if (!String(req.headers["content-type"]).startsWith("application/json")) return end(res, 415)
      const body = await json(req)
      if (url.pathname === "/hook") {
        onHook(body, url.searchParams.get("pid"))
        return end(res, 204)
      }
      if (url.pathname === "/answer") {
        const error = answer(body)
        return error ? reply(res, 409, error, "text/plain; charset=utf-8") : end(res, 204)
      }
    }
    end(res, 404)
  } catch (err) {
    log("request failed:", err.stack ?? err)
    end(res, 400)
  }
})

function openStream(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  res.write(`retry: 1000\ndata: ${JSON.stringify({ op: "reset", items: [...items.values()] })}\n\n`)
  clients.add(res)
  req.on("close", () => clients.delete(res))
}

// No SVG: served from this origin, it could run script against /answer.
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }

function serveViz(res, pathname) {
  const name = path.basename(decodeURIComponent(pathname))
  const type = IMAGE_TYPES[path.extname(name).toLowerCase()]
  const file = path.join(projectDir, "viz", name)
  if (!type || !fs.existsSync(file)) return end(res, 404)
  reply(res, 200, fs.readFileSync(file), type)
}

function reply(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" })
  res.end(body)
}

function end(res, status) {
  res.writeHead(status)
  res.end()
}

server.on("error", (err) => log(`viewer unavailable on port ${PORT}: ${err.message}`))
server.listen(PORT, "127.0.0.1", () => {
  listening = true
})

const TOOLS = [
  {
    name: "ask",
    description: [
      "Ask the user ONE question that has no right answer (their goal, a preference, a direction, what they want next, an open-ended reflection) and wait for their reply. It appears in the lesson viewer (their browser) and they answer there. This replaces AskUserQuestion, which is disabled in learn sessions. If the question has a correct answer, use quiz instead.",
      "",
      "- One question per call. For several, make several calls, each adapted to the last answer.",
      "- Omit options for a free-text answer. With options, the user can still type their own answer instead of, or alongside, a pick.",
      '- If you recommend an option, put it first and append "(Recommended)" to its label.',
      "- Set multiSelect: true only when several options can apply at once.",
      "- Markdown and LaTeX ($...$) render in the question, details and options.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The single question." },
        details: { type: "string", description: "Optional extra context shown under the question." },
        options: {
          type: "array",
          description: "Optional choices. Omit for a free-text answer.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Option text shown to the user." },
              description: { type: "string", description: "Optional detail shown under the option." },
            },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean", description: "True when several options can apply at once." },
      },
      required: ["question"],
    },
  },
  {
    name: "quiz",
    description: [
      "Ask the user a GRADED multiple-choice question with a known correct answer. It appears in the lesson viewer (their browser); this call blocks until they answer there, then returns the grade (correct/incorrect), the correct answer and your explanation, all computed by code. Unlike ask (preferences and decisions with no right answer), quiz always has a correct answer. Use it to (1) map what the learner already knows before teaching, and (2) run tight retrieval checks after explaining, or whenever you're unsure it landed.",
      "",
      "Rules:",
      "- correctAnswer is REQUIRED and is the option `value` (which defaults to the label), never a position. Single-select: one string. Multi-select: an array of strings, graded as an exact-set match. A value that matches no option is a hard error.",
      "- explanation is REQUIRED: say why the correct answer is correct. It is revealed only after they answer.",
      '- An "I don\'t know" choice is ALWAYS added automatically. Never add your own ("Not sure" etc.). A dontKnow result is a genuine gap, not a wrong guess: teach into it.',
      "- Any answer may carry a free-text note from the user. When present, let it steer your follow-up.",
      "- Make every distractor a specific, believable misconception or easily-confused neighbour, so WHICH wrong answer they pick tells you which gap to teach next. Each must still be unambiguously wrong on the intended reading. No trick questions.",
      "- Don't let the correct answer stand out by form: keep options similar in length, specificity and phrasing.",
      "- Options are shuffled before display by default. Set shuffle: false only when order is meaningful (ordered values, or an 'All/None of the above' option that must stay last).",
      "- Set multiSelect: true only when more than one option is correct.",
      "- Probe nuance with several quick quizzes, each adapted to the previous answer, rather than one giant question.",
      "- Markdown and LaTeX ($...$) render in the question, details, options and explanation.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The single question. One question per call." },
        details: { type: "string", description: "Optional extra context shown under the question." },
        options: {
          type: "array",
          minItems: 2,
          description: "The real, gradable answer options (2 or more).",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Option text shown to the user." },
              value: { type: "string", description: "Stable id that correctAnswer refers to. Defaults to the label." },
              description: { type: "string", description: "Optional detail shown under the option." },
            },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean", description: "True when more than one option is correct." },
        correctAnswer: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "The correct option value (single-select) or values (multi-select).",
        },
        explanation: { type: "string", description: "Why the correct answer is correct. Shown after they answer." },
        shuffle: { type: "boolean", description: "Defaults to true. Set false only when option order is meaningful." },
      },
      required: ["question", "options", "correctAnswer", "explanation"],
    },
  },
  {
    name: "render",
    description:
      "Render a Mermaid diagram or a hand-written SVG to a PNG and return it inline so you can LOOK at it. Pass the complete source on every call; there are no files to manage. Omit save_as to preview. When the picture is correct and clean, call again with save_as (a short kebab-case slug) to publish it into the project's viz/ folder; the result gives the filename to embed. On a syntax error you get the error text instead of an image.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["mermaid", "svg"] },
        source: {
          type: "string",
          description:
            "Complete Mermaid source (starting with the diagram type, e.g. `graph TD`), or a complete <svg>…</svg> with explicit width/height or a viewBox.",
        },
        save_as: {
          type: "string",
          description: "Kebab-case topic slug, e.g. 'internet-packets'. Set it only to publish the final version.",
        },
      },
      required: ["format", "source"],
    },
  },
]

const TOOL_HANDLERS = { ask, quiz, render }

const INSTRUCTIONS =
  `The lesson viewer runs at ${VIEWER_URL}. Everything you write is mirrored there live (Markdown, LaTeX, Mermaid, ` +
  "and images from the project's viz/ folder), and the user answers every question there: use ask for questions " +
  "with no right answer and quiz for graded ones. AskUserQuestion is disabled in learn sessions. " +
  "If the user can't see the viewer, give them that URL."

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
}

async function handle({ id, method, params }) {
  if (method === "initialize") {
    const protocolVersion = params?.protocolVersion ?? "2025-06-18"
    const serverInfo = { name: "learn", version: "0.1.0" }
    return send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo, instructions: INSTRUCTIONS } })
  }
  if (method === "tools/list") return send({ id, result: { tools: TOOLS } })
  if (method === "tools/call") return callTool(id, params)
  if (method === "notifications/cancelled") return cancel(params?.requestId)
  if (method === "ping") return send({ id, result: {} })
  if (id !== undefined && !method?.startsWith("notifications/")) {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

async function callTool(id, params) {
  // Claude Code aborts a call that stays silent for 30 minutes; the heartbeat lets a question wait on you.
  const token = params?._meta?.progressToken
  const message = params?.name === "render" ? "Rendering" : "Waiting for your answer in the lesson viewer"
  let beats = 0
  const heartbeat =
    token !== undefined &&
    setInterval(() => {
      beats += 1
      send({ method: "notifications/progress", params: { progressToken: token, progress: beats, message } })
    }, 10_000)
  try {
    if (!Object.hasOwn(TOOL_HANDLERS, params?.name)) throw new Error(`Unknown tool: ${params?.name}`)
    const result = await TOOL_HANDLERS[params.name](params.arguments ?? {}, id)
    if (result) send({ id, result })
  } catch (err) {
    send({ id, result: { isError: true, content: [{ type: "text", text: err.message }] } })
  } finally {
    clearInterval(heartbeat)
  }
}

const stdin = readline.createInterface({ input: process.stdin })
stdin.on("line", (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return log("unparseable message:", line.slice(0, 200))
  }
  handle(msg).catch((err) => log("handler failed:", err.stack ?? err))
})
// Stdin closes when the session ends; exiting frees the port.
stdin.on("close", () => process.exit(0))

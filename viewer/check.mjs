// Self-check for server.mjs: talks to it over stdio like Claude Code and answers over HTTP like the page.
// Run: node viewer/check.mjs  (add --render to exercise the Mermaid/SVG renderers; needs Chrome)

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const PORT = 4799
const BASE = `http://127.0.0.1:${PORT}`
const project = fs.mkdtempSync(path.join(os.tmpdir(), "learn-check-"))
const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs")], {
  cwd: project,
  env: { ...process.env, LEARN_PORT: String(PORT) },
  stdio: ["pipe", "pipe", "inherit"],
})

let nextId = 1
const replies = new Map() // request id → resolve
const progress = []
readline.createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "notifications/progress") progress.push(msg.params)
  else replies.get(msg.id)?.(msg)
})

function rpc(method, params) {
  const id = nextId++
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  return { id, done: new Promise((resolve) => replies.set(id, resolve)) }
}
const callTool = (name, args, _meta) => rpc("tools/call", { name, arguments: args, _meta })
const text = (msg) => msg.result.content.map((c) => c.text ?? "").join("\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function post(route, body, type = "application/json") {
  return fetch(BASE + route, { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(body) })
}

// The snapshot the page receives when it connects.
async function snapshot() {
  const reader = (await fetch(`${BASE}/events`)).body.getReader()
  let frame = ""
  while (!frame.includes("\n\n")) frame += new TextDecoder().decode((await reader.read()).value)
  reader.cancel()
  return JSON.parse(/^data: (.*)$/m.exec(frame)[1]).items
}

async function pendingCard() {
  for (let i = 0; i < 50; i++) {
    const card = (await snapshot()).find((it) => it.status === "pending")
    if (card) return card
    await sleep(100)
  }
  throw new Error("the card never appeared on the page")
}

const planets = [
  { label: "Mercury", value: "mercury" },
  { label: "Venus", value: "venus" },
  { label: "Mars", value: "mars" },
]
const quiz = (question, correctAnswer, extra = {}) =>
  callTool("quiz", { question, options: planets, correctAnswer, explanation: "Smallest orbit.", ...extra })
const indexOf = (card, label) => card.options.find((o) => o.label === label).index

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }).done
  assert.equal(init.result.serverInfo.name, "learn")
  const { result } = await rpc("tools/list", {}).done
  assert.deepEqual(result.tools.map((t) => t.name), ["ask", "quiz", "render"])
  await sleep(200) // let the HTTP server bind

  // quiz: correct, with a note; the key never reaches the page; one answer only
  let call = quiz("Closest to the Sun?", "mercury")
  let card = await pendingCard()
  assert.equal(card.result, undefined)
  assert.equal((await post("/answer", { id: card.id, selected: [indexOf(card, "Mercury")], note: " sure " })).status, 204)
  let reply = text(await call.done)
  assert.match(reply, /answered correctly/)
  assert.match(reply, /User's note: sure$/m)
  assert.match(reply, /Explanation: Smallest orbit\./)
  assert.equal((await post("/answer", { id: card.id, selected: [1] })).status, 409)

  // quiz: wrong; two picks rejected on single-select
  call = quiz("Q2", "mercury")
  card = await pendingCard()
  assert.equal((await post("/answer", { id: card.id, selected: [1, 2] })).status, 409)
  await post("/answer", { id: card.id, selected: [indexOf(card, "Venus")] })
  reply = text(await call.done)
  assert.match(reply, /answered incorrectly/)
  assert.match(reply, /Selected: \d\. Venus/)

  // quiz: multi-select is an exact-set match, and a JSON-stringified key still works
  call = quiz("Rocky?", '["mercury","mars"]', { multiSelect: true, shuffle: false })
  card = await pendingCard()
  await post("/answer", { id: card.id, selected: [1] })
  assert.match(text(await call.done), /answered incorrectly/)
  call = quiz("Rocky again?", ["mercury", "mars"], { multiSelect: true, shuffle: false })
  card = await pendingCard()
  await post("/answer", { id: card.id, selected: [3, 1] })
  assert.match(text(await call.done), /answered correctly/)

  // quiz: "I don't know" is its own outcome
  call = quiz("Q5", "venus")
  card = await pendingCard()
  await post("/answer", { id: card.id, dontKnow: true })
  reply = text(await call.done)
  assert.match(reply, /I don't know/)
  assert.doesNotMatch(reply, /Selected:/)

  // quiz: a key that matches no option is an error, not a silent wrong grade
  const bad = await quiz("Q6", "pluto").done
  assert.equal(bad.result.isError, true)
  assert.match(text(bad), /matches no option/)

  // Esc in the terminal cancels the card and gets no reply
  call = quiz("Q7", "venus")
  card = await pendingCard()
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: call.id } })}\n`)
  await sleep(200)
  assert.equal((await snapshot()).find((it) => it.id === card.id).status, "cancelled")

  // A waiting card sends a heartbeat, and stops once answered
  call = callTool("ask", { question: "Still there?" }, { progressToken: "beat" })
  card = await pendingCard()
  await sleep(10_500)
  assert.ok(progress.some((p) => p.progressToken === "beat"))
  await post("/answer", { id: card.id, text: "yes" })
  await call.done
  const beats = progress.length
  await sleep(10_500)
  assert.equal(progress.length, beats)

  // ask: free text, a pick plus words, and an empty answer rejected
  call = callTool("ask", { question: "What do you want to learn?" })
  card = await pendingCard()
  assert.equal(card.kind, "question")
  assert.equal((await post("/answer", { id: card.id, text: "  " })).status, 409)
  await post("/answer", { id: card.id, text: "integrals for physics" })
  assert.equal(text(await call.done), `[ask ${card.id}] User answered.\nAnswer: integrals for physics`)
  call = callTool("ask", { question: "Pace?", options: [{ label: "Slow" }, { label: "Fast" }] })
  card = await pendingCard()
  assert.equal((await post("/answer", { id: card.id, selected: [1, 2] })).status, 409)
  await post("/answer", { id: card.id, selected: [2], text: "with examples" })
  assert.match(text(await call.done), /Selected: 2\. Fast\nAlso wrote: with examples$/)

  // render rejects an unknown format before touching Chrome
  assert.equal((await callTool("render", { format: "png", source: "x" }).done).result.isError, true)

  // Transcript: commands, text, past quiz/ask cards; meta, subagent and AskUserQuestion entries stay out
  const user = (uuid, content, extra = {}) => ({ type: "user", uuid, message: { content }, ...extra })
  const assistant = (uuid, content, extra = {}) => ({ type: "assistant", uuid, message: { content }, ...extra })
  const toolUse = (id, name, input) => [{ type: "tool_use", id, name, input }]
  const toolResult = (id, content) => [{ type: "tool_result", tool_use_id: id, content }]
  const transcript = path.join(project, "session.jsonl")
  const entries = [
    user("u1", "<command-name>/learn:teach</command-name>\n<command-args>derivatives</command-args>"),
    user("u0", [{ type: "text", text: "skill body" }], { isMeta: true }),
    assistant("a1", [{ type: "text", text: "The slope is $f'(x)$." }]),
    assistant("a2", toolUse("t1", "AskUserQuestion", { questions: [{ question: "Goal?" }] })),
    user("u2", toolResult("t1", "answered"), { toolUseResult: { answers: { "Goal?": "Intuition" } } }),
    assistant("a3", toolUse("t2", "mcp__plugin_learn_learn__quiz", { question: "Old quiz?" })),
    user("u3", toolResult("t2", [{ type: "text", text: "[quiz old123] User answered correctly." }])),
    assistant("a5", toolUse("t3", "mcp__plugin_learn_learn__ask", { question: "Old ask?" })),
    user("u5", toolResult("t3", "[ask old456] User answered.\nAnswer: slowly")),
    assistant("s1", [{ type: "text", text: "subagent chatter" }], { isSidechain: true }),
  ]
  fs.writeFileSync(transcript, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`)
  await post(`/hook?pid=${process.pid}`, { transcript_path: transcript, cwd: project })
  const items = await snapshot()
  assert.deepEqual(items.map((it) => it.kind), ["user", "assistant", "replay", "replay"])
  assert.equal(items[0].text, "/learn:teach derivatives")
  assert.equal(items[2].question, "Old quiz?")
  assert.equal(items[3].tag, "Question")

  // Hooks from another Claude Code process are ignored
  await post("/hook?pid=1", { transcript_path: path.join(project, "other.jsonl"), cwd: project })
  assert.equal((await snapshot()).length, 4)

  // New lines show up; a half-written line waits for its newline
  const next = assistant("a4", [{ type: "text", text: "next — ✓" }])
  fs.appendFileSync(transcript, `${JSON.stringify(next)}\n{"type":"assis`)
  await sleep(600)
  const after = await snapshot()
  assert.equal(after.length, 5)
  assert.equal(after[4].text, "next — ✓")

  // Only images inside viz/ are served, and posts must be JSON
  fs.mkdirSync(path.join(project, "viz"))
  fs.writeFileSync(path.join(project, "viz", "a.png"), "png")
  assert.equal((await fetch(`${BASE}/viz/a.png`)).status, 200)
  assert.equal((await fetch(`${BASE}/viz/..%2Fsession.jsonl`)).status, 404)
  assert.equal((await post("/answer", {}, "text/plain")).status, 415)

  if (process.argv.includes("--render")) {
    const mermaid = await callTool("render", { format: "mermaid", source: "graph TD\n  A --> B" }).done
    assert.equal(mermaid.result.content[1]?.type, "image", text(mermaid))
    const broken = await callTool("render", { format: "mermaid", source: "graph TD\n  A -->" }).done
    assert.equal(broken.result.isError, true)
    const circle = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="40"/></svg>'
    const svg = await callTool("render", { format: "svg", source: circle, save_as: "Unit Circle!" }).done
    assert.match(text(svg), /filename: viz-unit-circle-\d+\.png/)
    assert.equal(fs.readdirSync(path.join(project, "viz")).filter((f) => f.startsWith("viz-unit-circle")).length, 1)
  }

  console.log("ok")
} finally {
  server.kill()
  fs.rmSync(project, { recursive: true, force: true })
}

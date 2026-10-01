# learn-claude-plugin-viewer

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

Eero Alvar's AI learning system as a **Claude Code plugin**, with a browser **lesson viewer**. You type in the terminal; you read the lesson, with LaTeX, Mermaid and images rendered, and answer every graded quiz in the browser.

## Credits

- **Original:** [amosblomqvist/learn](https://github.com/amosblomqvist/learn) by [Eero Alvar](https://github.com/amosblomqvist), from the video [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU). The teaching philosophy, the `teach` and `visualize` skills and the subagents are his work. It was built for [pi](https://github.com/earendil-works/pi) with custom extensions. His commits are kept in this repository's history.
- **Fork:** [metetik/learn-with-claude-code](https://github.com/metetik/learn-with-claude-code), the Claude Code port that rebuilds the system on skills, subagents and hooks with a Markdown session log. This plugin was built with that port as the reference for the Claude Code adaptation.

What this repository adds on top: the pi extensions are replaced by an MCP server that serves a lesson viewer and the `quiz`, `ask` and `render` tools, plus a `roadmap` skill.

## What's in it

- `skills/teach/`: the philosophy and the process (probe, plan, teach)
- `skills/visualize/`: adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `skills/roadmap/`: reads the roadmap.sh map of a software topic (topics, order, resources) to shape the lesson plan. Uses roadmap.sh's public endpoint and content repo, no browser needed.
- `agents/`: `researcher`, `svg-maker`, `mermaid-maker`, the subagents the system delegates to
- `viewer/`: the plugin's MCP server and lesson page, no dependencies
  - serves the viewer at `http://127.0.0.1:4747` and follows the session transcript live
  - `quiz` tool: graded questions answered in the viewer, grading done in code (correct/incorrect, the right answer, explanation, "I don't know", an optional note)
  - `ask` tool: questions with no right answer (goals, preferences), also answered in the viewer
  - `render` tool: Mermaid/SVG to PNG for the diagram makers, published into your project's `viz/`
- `hooks/hooks.json`: tells the viewer which session transcript to follow, and blocks `AskUserQuestion`. Its questions only reach the transcript after you answer them in the terminal, so the viewer could never show them in time.

## Install

Requirements:

- [Claude Code](https://claude.com/claude-code), any subscription
- Node 18+
- Google Chrome, for rendering diagrams. Set `CHROME_PATH` if it is not under `/Applications`. The first Mermaid render downloads `@mermaid-js/mermaid-cli` through `npx`.

Clone it anywhere:

```bash
git clone https://github.com/caiofeuser/learn-claude-plugin-viewer.git ~/learn-claude-plugin-viewer
```

No build step and no `npm install`.

## Run

From the directory of the project you want to learn in (any folder; lessons and diagrams land in its `viz/`):

```bash
claude --plugin-dir ~/learn-claude-plugin-viewer
```

A shell alias is handy:

```bash
alias learn='claude --plugin-dir ~/learn-claude-plugin-viewer'
```

Then:

1. Send any message. The viewer opens in your browser at `http://127.0.0.1:4747`.
2. Start a lesson with `/learn:teach <topic>`, or just ask to learn something.
3. Type in the terminal. Read, and answer every question, in the viewer.

Use `/learn:teach` rather than a project's own `/teach`. A project skill with the same name would teach with its own rules.

The first time a quiz or diagram tool runs, Claude Code asks permission for it. Choose "don't ask again".

## Notes

- One learning session at a time per port. For a second session at the same time, start it with `LEARN_PORT=4748`.
- Check the viewer after changing it: `node viewer/check.mjs --render`.
- The teaching skill is written for one learner. Edit it to fit how you learn best.

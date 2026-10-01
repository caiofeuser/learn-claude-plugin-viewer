---
name: roadmap
description: Consult roadmap.sh, the community-curated learning roadmaps for software topics, to shape a lesson plan with the field's real topics, the order people learn them in, and vetted notes and resources per topic. Use in the plan phase of teaching, and whenever the learner asks what to learn next, if the subject is covered by a roadmap.sh roadmap (languages, frameworks, frontend, backend, devops, databases, computer science, system design, AI and ML, and more). Skip it for subjects outside software.
---

# Roadmap

A roadmap.sh roadmap is a map of a field that the community has already curated: the topics that matter, the order people learn them in, and vetted resources for each. Use it as the skeleton of the plan instead of reconstructing the field's shape from memory.

## Get the data

`roadmap.mjs`, next to this file, reads roadmap.sh's public roadmap endpoint and its official content repo. No browser, no login. Run it with Node from this skill's base directory:

```bash
node <base dir>/roadmap.mjs find <words>        # which roadmaps cover a topic, e.g. find derivatives
node <base dir>/roadmap.mjs <slug>              # main path in order, then every box with its position
node <base dir>/roadmap.mjs <slug> <id> [<id>]  # curated notes and resources for chosen topics
node <base dir>/roadmap.mjs                     # every roadmap slug
```

1. **Find the roadmap.** Search with the learner's goal terms, or pick from the list. A subject often lives inside a broader roadmap: derivatives, for instance, sit in `machine-learning`.
2. **Read the map.** The main path is the curriculum order. Below it, every box is listed with its position, because the roadmap is a drawing rather than a tree: subtopics near a topic belong to it, and `label` boxes name groups. Work out the groups from the positions; don't assume a subtopic belongs to the topic listed just above it.
3. **Pull notes sparingly.** Fetch notes only for the handful of topics the plan will actually use.

If no roadmap covers the subject, say so in one line and plan without it.

## Use it in the plan

- The roadmap maps the *field*, not *this learner*. Cut it to the learner's goal (Phase 1b) and start at their edge (Phase 1a). Never march through it top to bottom.
- Its order is a curriculum order, which is usually but not always a dependency order. Build the dependency map from first principles, and use the roadmap to catch missing topics and to sanity-check the sequence.
- When presenting the plan, name the roadmap and link it: `https://roadmap.sh/<slug>`.
- Resources are for going deeper once a node has landed: offer one or two per node, taken from the notes, never a list dump.
- A roadmap note is a starting point, not a citation. Facts you teach still follow the accuracy rule: when unsure, verify with `learn:researcher`.

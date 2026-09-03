# `@paperai/project-service`

English | [中文](README.zh.md)

`ctx.paperProjects` owns the single PaperAI create-or-adopt operation. A user selects or supplies a directory; the service idempotently initializes it, associates its canonical path with the DSH workspace registry, and writes one `ProjectRecord` through `ctx.paperRepository`. There is no separate open-project operation.

## Project layout

The service creates only missing directories and never rewrites existing files, with one exception: the PaperAI-owned block of `AGENTS.md` described below.

```text
PAPERAI.md
AGENTS.md
CLAUDE.md
documents/
  source/
  working/
  history/
templates/
references/
figures/
experiments/
  data/
  results/
code/
exports/
  drafts/
  delivery/
```

`documents/source/` holds immutable imports, `documents/working/` holds authoritative Working DOCX files, and `documents/history/` holds recoverable snapshots. `PAPERAI.md` gives later Agents a compact place for the current goal, progress, working agreements, and next step. It is created with exclusive file creation and is never overwritten when already present; an existing non-file path with that name fails initialization without replacing it.

## Writing charter

`AGENTS.md` carries the Agent writing charter: the document workflow, red lines, and a per-document template summary rendered from the repository. Only the block between `<!-- paperai:charter:start` and `<!-- paperai:charter:end -->` belongs to PaperAI. Initialization writes it, and every durable `paperai` documents change (import, template association, deletion) re-renders it through one serialized queue, rewriting the file only when the content differs; text outside the markers is preserved byte-for-byte, and a half-present marker pair fails the sync loudly instead of guessing. `CLAUDE.md` is created with `@AGENTS.md` so Claude Code imports the same charter; an existing `CLAUDE.md` keeps its content byte-for-byte and gains one appended `@AGENTS.md` line when it imports the charter in neither the `@AGENTS.md` nor the `@./AGENTS.md` spelling, so an adopted project with its own Claude instructions still routes Claude to the charter. Both files are regenerable, so an interrupted write is repaired by the next sync pass.

## Service API

```ts
import type { ProjectRecord } from '@paperai/domain'
import type { ProjectGitStatus } from '@paperai/project-service'

interface CreatePaperProjectInput {
  rootPath: string
  name?: string
}

interface CreatePaperProjectResult {
  project: ProjectRecord
  projectCreated: boolean
  contextFile: 'created' | 'preserved'
  git: ProjectGitStatus
}
```

`create(input)` serializes initialization calls. Repeating it for the same canonical path preserves the project id, name, creation time, context file, and all user files. If a DSH workspace exists for the path, the service reuses it. If the project record points at a workspace registration that was recreated, the service repairs the association without changing project identity.

Fatal filesystem, workspace, and repository failures remove only unchanged files and empty directories created by the current call. A newly registered workspace is also removed when repository publication fails. Existing content is never recursively deleted. If rollback itself fails, the service reports the initiating and cleanup failures together.

After project publication, the service uses optional `ctx.subprocess` to run exact Git argv without a shell. An enclosing repository is reused; otherwise `git init --initial-branch <name>` runs at the project root. Missing subprocess support, missing Git, timeout, oversized output, or a non-zero initialization exit returns `git.status: 'degraded'` without discarding the usable project.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `gitCommand` | `git` | Executable name or absolute path resolved by the subprocess Provider. |
| `gitInitialBranch` | `main` | Initial branch for a newly initialized repository. |
| `gitTimeoutMs` | `15000` | Deadline for each Git command. |
| `gitOutputMaxBytes` | `262144` | In-memory cap for each Git output stream. |
| `gitTerminateGraceMs` | `2000` | Process-tree termination grace. |

All numeric limits must be positive safe integers. Blank command, branch, path, and explicit project names fail before publication.

## Model Experience

### `PAPERAI.md` workspace context

#### What the model sees

Project creation does not alter a model request. A later Agent sees the compact goal, progress, working-agreement, and next-step headings only when it reads `PAPERAI.md` through ordinary workspace tools; subsequent user or Agent edits replace the initial content as the durable project context.

#### Token effect

Zero during project creation. A later read consumes tokens for the selected `PAPERAI.md` content and the workspace tool result that carries it.

#### KV Cache effect

None during project creation. A later read enters the ordinary conversation prefix as a tool result, so edits to `PAPERAI.md` can invalidate reuse from that point without changing a package-owned system prompt.

## Known Limitations and Deferred Work

- A process crash between filesystem or workspace initialization and repository publication can leave reusable project directories or a workspace registration without a `ProjectRecord`; the next `create()` converges the same path.
- Project move and deletion are not owned by this package yet; callers must not infer them from the create-or-adopt operation.

const { execFileSync } = require('node:child_process')
const { mkdtemp, mkdir, writeFile, readFile, symlink, cp, rm } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

async function main() {
  const repo = resolve(process.argv[2] || process.cwd())
  const { createJiti } = require(join(repo, 'node_modules/jiti'))
  const root = await mkdtemp(join(tmpdir(), 'machete-main-bench-'))
  await mkdir(join(root, 'baseline'))
  const baseline = '4468985c4e312628beace0cef42c7a1e73a9660b'
  execFileSync('tar', ['-x', '-C', join(root, 'baseline')], {
    input: execFileSync('git', ['-C', repo, 'archive', baseline, 'src']),
  })
  await cp(join(repo, 'src'), join(root, 'candidate/src'), { recursive: true })
  for (const name of ['baseline', 'candidate'])
    await symlink(join(repo, 'node_modules'), join(root, name, 'node_modules'))
  const jiti = createJiti(__filename, { fsCache: false })
  const versions = {}
  for (const name of ['baseline', 'candidate']) {
    const source = join(root, name, 'src')
    versions[name] = {
      Store: (await jiti.import(join(source, 'main/store.ts'))).LibraryStore,
      Editing: (await jiti.import(join(source, 'renderer/src/lib/draft-editing.ts'))).DraftEditing,
    }
  }
  const { createLibrary } = await jiti.import(join(root, 'candidate/src/shared/library.ts'))
  const library = createLibrary()
  library.draft = { text: 'draft', boardId: 'inbox' }
  library.clips = Array.from({ length: 30_000 }, (_, i) => ({
    id: `clip-${i}`,
    boardId: 'inbox',
    text: `Clip ${i} ` + 'x'.repeat(1024),
    createdAt: i,
    updatedAt: i,
    deletedAt: null,
  }))
  const fixture = JSON.stringify(library, null, 2)
  const samples = []
  for (let round = 1; round <= 3; round++) {
    for (const workload of ['sequential', 'burst', 'sustained']) {
      for (const name of round % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        const directory = await mkdtemp(join(tmpdir(), 'machete-main-bench-data-'))
        let timer
        try {
          const path = join(directory, 'collection.json')
          await writeFile(path, fixture)
          const store = await versions[name].Store.open(path)
          let lastResponse
          const editing = new versions[name].Editing({
            editDraft: async (request) => {
              const result = await store.editDraft(request, true)
              // Mirrors each version's IPC response envelope, without Chromium transport.
              lastResponse = result.library
                ? {
                    accepted: result.accepted,
                    snapshot: {
                      library: result.library,
                      revision: result.revision,
                      draftWriteId: result.draftWriteId,
                      shortcutError: null,
                    },
                  }
                : {
                    accepted: result.accepted,
                    revision: result.revision,
                    draftWriteId: result.draftWriteId,
                  }
              return lastResponse
            },
          })
          editing.receive({
            library: store.getState(),
            revision: store.getRevision(),
            draftWriteId: store.getDraftWriteId(),
            shortcutError: null,
          })
          editing.change({ text: 'warmup', boardId: 'inbox' })
          await editing.whenIdle()
          const acknowledgementBytes = Buffer.byteLength(JSON.stringify(lastResponse))
          let writes = 0
          const persist = store.persist.bind(store)
          store.persist = async (next) => {
            writes++
            await persist(next)
          }
          let maxTimerGapMs = 0,
            previous = performance.now()
          timer = setInterval(() => {
            const now = performance.now()
            maxTimerGapMs = Math.max(maxTimerGapMs, now - previous)
            previous = now
          }, 1)
          await new Promise((resolve) => setTimeout(resolve, 10))
          const started = performance.now()
          const updates = workload === 'sequential' ? 5 : 20
          for (let i = 0; i < updates; i++) {
            editing.change({ text: `typed ${i}`, boardId: 'inbox' })
            if (workload === 'sequential') await editing.whenIdle()
            if (workload === 'sustained') await new Promise((resolve) => setTimeout(resolve, 20))
          }
          await editing.whenIdle()
          const elapsedMs = performance.now() - started
          await new Promise((resolve) => setTimeout(resolve, 10))
          clearInterval(timer)
          timer = undefined
          if (store.getState().draft.text !== `typed ${updates - 1}`)
            throw new Error('Final draft was not durably retained')
          const sample = {
            version: name,
            workload,
            round,
            updates,
            writes,
            elapsedMs: Math.round(elapsedMs),
            maxTimerGapMs: Math.round(maxTimerGapMs),
            acknowledgementBytes,
          }
          samples.push(sample)
          console.log(JSON.stringify(sample))
        } finally {
          if (timer) clearInterval(timer)
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  }
  const sourceHashes = {}
  for (const relative of [
    'src/main/store.ts',
    'src/renderer/src/lib/draft-editing.ts',
    'src/shared/bridge.ts',
  ]) {
    sourceHashes[relative] = createHash('sha256')
      .update(await readFile(join(root, 'candidate', relative)))
      .digest('hex')
  }
  const result = {
    baseline,
    candidateParent: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    fixtureBytes: Buffer.byteLength(fixture),
    sourceHashes,
    samples,
  }
  await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2))
  console.log('RESULTS ' + join(root, 'results.json'))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

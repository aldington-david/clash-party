import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const source = resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)))
const read = (name) => readFileSync(resolve(source, name), 'utf8')
const compile = (text) =>
  ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText

function loadModule(name, dependencies = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(compile(read(name)), {
    exports,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    ...globals
  })
  return exports
}

const { deepMerge } = loadModule('src/main/utils/merge.ts')
function loadConfig(input) {
  const writes = []
  let writeFails = false
  const api = loadModule('src/main/config/app.ts', {
    'fs/promises': { readFile: async () => JSON.stringify(input) },
    '../utils/dirs': { appConfigPath: () => 'mock-config.yaml' },
    '../utils/safeFile': {
      WriteQueue: class {
        run(action) {
          return action()
        }
      },
      atomicWriteFile: async (_, value) => {
        if (writeFails) throw new Error('simulated write failure')
        writes.push(JSON.parse(value))
      }
    },
    '../utils/yaml': { parse: JSON.parse, stringify: JSON.stringify },
    '../utils/merge': { deepMerge },
    '../utils/template': {
      defaultConfig: {
        modeSelected: false,
        operationMode: 'standard',
        core: 'mihomo',
        maxLogFileSize: 5
      }
    },
    '../utils/logFile': {
      normalizeMaxLogFileSizeMB: (value) => value,
      setCoreLogDisabled: () => undefined,
      setGlobalMaxLogFileSizeMB: () => undefined
    },
    '../utils/logger': { setAppLogDisabled: () => undefined }
  })
  return { api, writes, failWrites: () => (writeFails = true) }
}

const legacy = loadConfig({ core: 'mihomo-smart', enableSmartCore: true, keep: 'value' })
const migrated = await legacy.api.getAppConfig()
assert.equal(migrated.modeSelected, true)
assert.equal(migrated.operationMode, 'standard')
assert.equal(migrated.core, 'mihomo')
assert.equal(migrated.enableSmartCore, false)
assert.equal(migrated.enableSmartOverride, false)
assert.equal(legacy.writes.at(-1).keep, 'value')
assert.equal(legacy.writes.at(-1).modeSelected, true)

const fresh = loadConfig({ modeSelected: false, operationMode: 'standard' })
assert.equal((await fresh.api.getAppConfig()).modeSelected, false)
const simple = loadConfig({ modeSelected: true, operationMode: 'simple', core: 'mihomo-specific' })
assert.equal((await simple.api.getAppConfig()).operationMode, 'simple')
assert.equal((await simple.api.getAppConfig()).core, 'mihomo-specific')
await simple.api.patchAppConfig({ core: 'mihomo-alpha', enableSmartCore: true })
assert.equal(simple.writes.at(-1).core, 'mihomo')
assert.equal(simple.writes.at(-1).operationMode, 'simple')

legacy.failWrites()
await assert.rejects(
  legacy.api.patchAppConfig({ operationMode: 'simple' }),
  /simulated write failure/
)
assert.equal((await legacy.api.getAppConfig()).operationMode, 'standard')
await assert.rejects(
  legacy.api.syncAppConfigAfterApply({ operationMode: 'simple', core: 'mihomo-alpha' }),
  /simulated write failure/
)
assert.equal((await legacy.api.getAppConfig()).operationMode, 'simple')
assert.equal((await legacy.api.getAppConfig()).core, 'mihomo')

const windowSource = ts.createSourceFile(
  'window.ts',
  read('src/main/window.ts'),
  ts.ScriptTarget.Latest
)
const waitFunction = windowSource.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'waitForInitialContent'
)
assert.ok(waitFunction)
class LegacyPromise extends Promise {}
LegacyPromise.withResolvers = undefined
for (const trigger of ['ready', 'closed', 'timeout']) {
  const ipcMain = new EventEmitter()
  const window = new EventEmitter()
  window.webContents = new EventEmitter()
  const unrelatedListener = () => {}
  ipcMain.on('rendererFirstContentReady', unrelatedListener)
  let timeout
  let cleared = false
  const wait = vm.runInNewContext(
    compile(waitFunction.getText(windowSource)) + '\nwaitForInitialContent',
    {
      ipcMain,
      Promise: LegacyPromise,
      setTimeout(callback, delay) {
        assert.equal(delay, 5000)
        timeout = callback
        return 1
      },
      clearTimeout(id) {
        assert.equal(id, 1)
        cleared = true
      }
    }
  )
  let finished = false
  const pending = wait(window).then(() => (finished = true))
  assert.equal(ipcMain.listenerCount('rendererFirstContentReady'), 2)
  ipcMain.emit('rendererFirstContentReady', { sender: {} })
  await Promise.resolve()
  assert.equal(finished, false)
  assert.equal(ipcMain.listenerCount('rendererFirstContentReady'), 2)
  if (trigger === 'ready') ipcMain.emit('rendererFirstContentReady', { sender: window.webContents })
  if (trigger === 'closed') window.emit('closed')
  if (trigger === 'timeout') timeout()
  assert.ok(cleared)
  await pending
  assert.equal(window.listenerCount('closed'), 0)
  assert.deepEqual(ipcMain.listeners('rendererFirstContentReady'), [unrelatedListener])
}

const messages = []
const startup = loadModule(
  'src/renderer/src/utils/startup.ts',
  {},
  {
    window: { electron: { ipcRenderer: { send: (channel) => messages.push(channel) } } }
  }
)
startup.markInitialContentPartReady('route')
assert.equal(messages.length, 0)
startup.markInitialContentPartReady('sider')
startup.markInitialContentPartReady('route')
assert.deepEqual(messages, ['rendererFirstContentReady'])
let lateListenerRan = false
startup.onInitialContentReady(() => (lateListenerRan = true))
assert.ok(lateListenerRan)
console.log('v2.0.4 migration, persistence, legacy IPC and first-content checks passed')

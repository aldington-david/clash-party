import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { resolve } from 'node:path'
import { createHash } from 'node:crypto'
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
function loadConfig(
  input,
  defaults = { modeSelected: false, operationMode: 'standard', core: 'mihomo', maxLogFileSize: 5 }
) {
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
      defaultConfig: defaults
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

const clone = (value) => JSON.parse(JSON.stringify(value))
const shared = loadModule('src/shared/appConfig.ts')
const templates = (platform) =>
  loadModule(
    'src/main/utils/template.ts',
    {
      '../../shared/appConfig': shared
    },
    { process: { platform } }
  )
const { defaultConfig, defaultControledMihomoConfig } = templates('win32')
const expectedApp = {
  silentStart: true,
  proxyInTray: false,
  useSubStore: false,
  autoCloseConnection: false,
  proxyDisplayMode: 'full',
  profileDisplayDate: 'update',
  dnsCardStatus: 'hidden',
  sniffCardStatus: 'hidden',
  mihomoCpuPriority: 'PRIORITY_ABOVE_NORMAL',
  controlDns: false,
  controlSniff: false,
  customTheme: 'homohub.css',
  connectionDirection: 'asc'
}
function checkAppDefaults(config) {
  for (const [key, expected] of Object.entries(expectedApp))
    assert.equal(config[key], expected, key)
  assert.equal(config.connectionViewMode ?? 'list', 'list')
  assert.deepEqual(clone(config.sysProxy), { enable: false, mode: 'auto' })
  assert.equal(config.autoCheckUpdate, true)
}
checkAppDefaults(defaultConfig)
for (const input of [null, {}, clone(defaultConfig)]) {
  checkAppDefaults(await loadConfig(input, defaultConfig).api.getAppConfig())
}
const savedApp = {
  modeSelected: true,
  operationMode: 'standard',
  silentStart: false,
  proxyInTray: true,
  useSubStore: true,
  autoCloseConnection: true,
  proxyDisplayMode: 'simple',
  profileDisplayDate: 'expire',
  dnsCardStatus: 'col-span-1',
  sniffCardStatus: 'col-span-1',
  mihomoCpuPriority: 'PRIORITY_NORMAL',
  controlDns: true,
  controlSniff: true,
  customTheme: 'user.css',
  connectionDirection: 'desc',
  connectionViewMode: 'table',
  sysProxy: { enable: true, mode: 'manual' }
}
const retainedApp = await loadConfig(savedApp, defaultConfig).api.getAppConfig()
for (const [key, expected] of Object.entries(savedApp))
  assert.deepEqual(clone(retainedApp[key]), expected, key)
const queue = class {
  run(action) {
    return action()
  }
}
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const simpleShared = loadModule('src/shared/simple-config.ts')
async function readControlled(input, exists = true) {
  const writes = []
  const config = loadModule('src/main/config/controledMihomo.ts', {
    'fs/promises': { readFile: async () => JSON.stringify(input) },
    fs: { existsSync: () => exists },
    '../utils/dirs': { controledMihomoConfigPath: () => 'fixture-mihomo.yaml' },
    '../utils/yaml': { parse: JSON.parse, stringify: JSON.stringify },
    '../core/factory': {},
    '../core/mihomoApi': {},
    '../utils/template': { defaultControledMihomoConfig },
    '../utils/merge': { deepMerge },
    '../utils/logger': { createLogger: () => logger },
    '../utils/safeFile': {
      WriteQueue: queue,
      atomicWriteFile: async (_, data) => writes.push(JSON.parse(data))
    },
    '../../shared/appConfig': shared,
    '../../shared/simple-config': simpleShared,
    './app': { getAppConfig: async () => ({ operationMode: 'standard' }) }
  })
  return { config: await config.getControledMihomoConfig(), writes }
}
for (const [platform, device] of [
  ['win32', 'Mihomo'],
  ['linux', 'Mihomo'],
  ['darwin', 'utun1500']
]) {
  const config = templates(platform).defaultControledMihomoConfig
  assert.equal(config.tun.device, device)
  assert.equal(config.tun.enable, false)
  assert.equal(config.tun.stack, 'mips')
  assert.equal(config.tun['strict-route'], true)
}
for (const config of [
  defaultControledMihomoConfig,
  (await readControlled(null, false)).config,
  (await readControlled({})).config
]) {
  for (const [key, value] of Object.entries({
    'allow-lan': false,
    ipv6: true,
    'tcp-concurrent': true,
    'geo-auto-update': true,
    'log-level': 'silent'
  })) {
    assert.equal(config[key], value, key)
  }
  assert.equal(config.tun.stack, 'mips')
  assert.equal(config.tun['strict-route'], true)
}
const savedCore = {
  'allow-lan': true,
  ipv6: false,
  'tcp-concurrent': false,
  'geo-auto-update': false,
  'log-level': 'warning',
  tun: { enable: true, stack: 'mixed', 'strict-route': false }
}
const retainedCore = (await readControlled(savedCore)).config
for (const [key, value] of Object.entries(savedCore)) {
  if (key !== 'tun') assert.equal(retainedCore[key], value, key)
}
for (const [key, value] of Object.entries(savedCore.tun))
  assert.equal(retainedCore.tun[key], value, key)

const guard = loadModule('src/main/core/dnsOverrideGuard.ts', {
  crypto: { createHash },
  '../config': {},
  '../window': { mainWindow: null },
  '../utils/logger': { createLogger: () => logger },
  '../../shared/appConfig': shared
})
const subscription = {
  proxies: [],
  'proxy-groups': [],
  rules: ['MATCH,DIRECT'],
  dns: { enable: true, nameserver: ['192.0.2.53'], 'proxy-server-nameserver': ['192.0.2.54'] },
  hosts: { 'fixture.invalid': '192.0.2.1' },
  sniffer: { enable: false, 'skip-domain': ['fixture.invalid'] }
}
for (const config of [
  defaultConfig,
  { ...defaultConfig, controlDns: true, controlSniff: true, disableDnsOverrideGuard: true }
]) {
  const writes = []
  const controlled = {
    ...clone(defaultControledMihomoConfig),
    hosts: { 'controlled.invalid': '192.0.2.2' }
  }
  const factory = loadModule('src/main/core/factory.ts', {
    'fs/promises': {},
    vm: {},
    fs: { existsSync: () => false },
    path,
    net: { isIP: () => 0 },
    '../config': {
      getAppConfig: async () => config,
      getProfileConfig: async () => ({ current: 'fixture' }),
      getProfileItem: async () => ({ override: [] }),
      getProfile: async () => clone(subscription),
      getOverrideConfig: async () => ({ items: [] }),
      getControledMihomoConfig: async () => controlled
    },
    '../utils/dirs': {
      mihomoWorkConfigPath: () => 'fixture-output.yaml',
      rulePath: () => 'fixture-rules.yaml'
    },
    '../utils/yaml': { parse: JSON.parse, stringify: JSON.stringify },
    '../utils/merge': { deepMerge },
    '../utils/logger': { createLogger: () => logger },
    '../utils/age': {},
    '../../shared/appConfig': shared,
    '../utils/safeFile': { atomicWriteFile: async (_, data) => writes.push(JSON.parse(data)) },
    '../simple/service': {},
    './dnsOverrideGuard': guard
  })
  await factory.generateProfile(undefined, { updateRuntimeConfig: false })
  const output = writes.at(-1)
  if (!config.controlDns) {
    assert.deepEqual(output.dns, subscription.dns)
    assert.deepEqual(output.hosts, subscription.hosts)
    assert.deepEqual(output.sniffer, subscription.sniffer)
  } else {
    assert.notDeepEqual(output.dns, subscription.dns)
    assert.equal(output.sniffer.enable, true)
  }
  assert.equal(output.tun.enable, false)
  assert.equal(output.tun.stack, 'mips')
  assert.equal(output.tun['strict-route'], true)
  assert.equal(output['log-level'], 'info')
}

const initSource = ts.createSourceFile(
  'init.ts',
  read('src/main/utils/init.ts'),
  ts.ScriptTarget.Latest
)
const seedTheme = initSource.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'initBundledTheme'
)
assert.ok(seedTheme)
assert.match(
  read('electron-builder.yml'),
  /from: '\.\/resources\/themes\/homohub\.css'\s+to: 'files\/homohub\.css'/
)
assert.match(read('resources/themes/homohub.css'), /^\/\* HomoHub \*\//)
assert.match(
  read('src/main/utils/init.ts'),
  /await initDirs\(\)\s+await initBundledTheme\(\)\s+await initConfig\(\)/
)
const themeDir = await mkdtemp(path.join(tmpdir(), 'party-theme-test-'))
try {
  const resources = path.join(themeDir, 'resources')
  await mkdir(resources)
  await cp(resolve(source, 'resources/themes/homohub.css'), path.join(resources, 'homohub.css'))
  for (const isPackaged of [true, false]) {
    const target = path.join(themeDir, String(isPackaged))
    await mkdir(target)
    const seed = vm.runInNewContext(compile(seedTheme.getText(initSource)) + '\ninitBundledTheme', {
      path,
      cp,
      existsSync,
      themesDir: () => target,
      resourcesFilesDir: () => resources,
      app: { isPackaged, getAppPath: () => source }
    })
    await seed()
    assert.equal(
      readFileSync(path.join(target, 'homohub.css'), 'utf8'),
      read('resources/themes/homohub.css')
    )
    await writeFile(path.join(target, 'homohub.css'), 'user theme')
    await seed()
    assert.equal(readFileSync(path.join(target, 'homohub.css'), 'utf8'), 'user theme')
  }
} finally {
  await rm(themeDir, { recursive: true, force: true })
}
console.log(
  'Approved defaults, stored choices, DNS/sniff inheritance and offline theme checks passed'
)

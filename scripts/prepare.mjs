import fs from 'fs'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import path from 'path'
import zlib from 'zlib'
import { extract } from 'tar'
import { execSync } from 'child_process'

const cwd = process.cwd()
const TEMP_DIR = path.join(cwd, 'node_modules/.temp')
const platform = process.platform

// 目标架构解析优先级：命令行参数 > npm_config_arch 环境变量 > 当前进程架构
// CI 交叉编译（如 ubuntu x64 宿主构建 arm64 包）时，若参数未传递到位，
// 会误用宿主机的 x64 架构下载 sidecar，导致 arm64 包内混入 x64 二进制
const SUPPORTED_ARCHS = ['x64', 'ia32', 'arm64']
function resolveTargetArch() {
  const args = process.argv.slice(2)
  if (args.length !== 0) {
    return args[0].replace('--', '')
  }
  const npmArch = process.env.npm_config_arch
  if (npmArch && SUPPORTED_ARCHS.includes(npmArch)) {
    return npmArch
  }
  return process.arch
}
const arch = resolveTargetArch()

/* This fork bundles only the pinned AnyTLS + REALITY stable core. */
const { core_tag: MIHOMO_VERSION } = JSON.parse(fs.readFileSync('.anytls-build.json', 'utf8'))
if (!/^v\d+\.\d+\.\d+$/.test(MIHOMO_VERSION)) throw new Error('Invalid pinned core tag')
const MIHOMO_URL_PREFIX = 'https://github.com/aldington-david/mihomo/releases/download'
const MIHOMO_MAP = {
  'win32-x64': 'mihomo-windows-amd64-compatible',
  'darwin-x64': 'mihomo-darwin-amd64-compatible',
  'darwin-arm64': 'mihomo-darwin-arm64',
  'linux-x64': 'mihomo-linux-amd64-compatible',
  'linux-arm64': 'mihomo-linux-arm64'
}
function mihomo() {
  let name = MIHOMO_MAP[`${platform}-${arch}`]
  if (!name) throw new Error(`unsupported platform "${platform}-${arch}"`)
  if (platform === 'win32' && process.env.LEGACY_BUILD === 'true') name += '-go120'
  const isWin = platform === 'win32'
  const zipFile = `${name}-${MIHOMO_VERSION}.${isWin ? 'zip' : 'gz'}`
  return {
    name: 'mihomo',
    targetFile: `mihomo${isWin ? '.exe' : ''}`,
    exeFile: `${name}${isWin ? '.exe' : ''}`,
    zipFile,
    downloadURL: `${MIHOMO_URL_PREFIX}/${MIHOMO_VERSION}/${zipFile}`
  }
}
/**
 * download sidecar and rename
 */
async function resolveSidecar(binInfo) {
  const { name, targetFile, zipFile, downloadURL } = binInfo

  const sidecarDir = path.join(cwd, 'extra', 'sidecar')
  const sidecarPath = path.join(sidecarDir, targetFile)

  fs.mkdirSync(sidecarDir, { recursive: true })
  if (fs.existsSync(sidecarPath)) {
    fs.rmSync(sidecarPath)
  }
  const tempDir = path.join(TEMP_DIR, name)
  const tempZip = path.join(tempDir, zipFile)

  fs.mkdirSync(tempDir, { recursive: true })
  try {
    if (!fs.existsSync(tempZip)) {
      await downloadFile(downloadURL, tempZip)
    }

    const checksums = await fetch(`${MIHOMO_URL_PREFIX}/${MIHOMO_VERSION}/sha256sum.txt`)
    if (!checksums.ok) throw new Error(`Cannot fetch core checksums: ${checksums.status}`)
    const expected = (await checksums.text())
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find((fields) => fields[1]?.replace(/^\*/, '') === zipFile)?.[0]
    const actual = createHash('sha256').update(fs.readFileSync(tempZip)).digest('hex')
    if (!expected || actual !== expected.toLowerCase()) throw new Error('Core checksum mismatch')
    fs.writeFileSync(
      'core-build-info.json',
      JSON.stringify(
        {
          repository: 'aldington-david/mihomo',
          tag: MIHOMO_VERSION,
          asset: zipFile,
          sha256: actual
        },
        null,
        2
      )
    )

    if (zipFile.endsWith('.zip')) {
      const zip = new AdmZip(tempZip)
      const entries = zip
        .getEntries()
        .filter((entry) => !entry.isDirectory && /^mihomo[^/\\]*\.exe$/.test(entry.entryName))
      if (entries.length !== 1)
        throw new Error('Core ZIP must contain exactly one mihomo executable')
      fs.writeFileSync(sidecarPath, entries[0].getData())
      console.log(`[INFO]: "${name}" unzip finished`)
    } else if (zipFile.endsWith('.tgz')) {
      // tgz
      fs.mkdirSync(tempDir, { recursive: true })
      await extract({
        cwd: tempDir,
        file: tempZip
      })
      const files = fs.readdirSync(tempDir)
      console.log(`[DEBUG]: "${name}" files in tempDir:`, files)
      const extractedFile = files.find((file) => file.startsWith('虚空终端-'))
      if (extractedFile) {
        const extractedFilePath = path.join(tempDir, extractedFile)
        fs.renameSync(extractedFilePath, sidecarPath)
        console.log(`[INFO]: "${name}" file renamed to "${sidecarPath}"`)
        execSync(`chmod 755 ${sidecarPath}`)
        console.log(`[INFO]: "${name}" chmod binary finished`)
      } else {
        throw new Error(`Expected file not found in ${tempDir}`)
      }
    } else {
      // gz
      const readStream = fs.createReadStream(tempZip)
      const writeStream = fs.createWriteStream(sidecarPath)
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          console.error(`[ERROR]: "${name}" gz failed:`, error.message)
          reject(error)
        }
        readStream
          .pipe(zlib.createGunzip().on('error', onError))
          .pipe(writeStream)
          .on('finish', () => {
            console.log(`[INFO]: "${name}" gunzip finished`)
            execSync(`chmod 755 ${sidecarPath}`)
            console.log(`[INFO]: "${name}" chmod binary finished`)
            resolve()
          })
          .on('error', onError)
      })
    }
  } catch (err) {
    // 需要删除文件
    fs.rmSync(sidecarPath, { force: true })
    throw err
  } finally {
    fs.rmSync(tempDir, { recursive: true })
  }
}

/**
 * download the file to the extra dir
 */
async function resolveResource(binInfo) {
  const { file, downloadURL } = binInfo

  const resDir = path.join(cwd, 'extra', 'files')
  const targetPath = path.join(resDir, file)

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath)
  }

  fs.mkdirSync(resDir, { recursive: true })
  await downloadFile(downloadURL, targetPath)

  console.log(`[INFO]: ${file} finished`)
}

/**
 * download file and save to `path`
 */
async function downloadFile(url, path) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/octet-stream' }
  })
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} for "${url}"`)
  }
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(path, new Uint8Array(buffer))

  console.log(`[INFO]: download finished "${url}"`)
}

const resolveMmdb = () =>
  resolveResource({
    file: 'country.mmdb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country-lite.mmdb`
  })
const resolveMetadb = () =>
  resolveResource({
    file: 'geoip.metadb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb`
  })
const resolveGeosite = () =>
  resolveResource({
    file: 'geosite.dat',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat`
  })
const resolveGeoIP = () =>
  resolveResource({
    file: 'geoip.dat',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat`
  })
const resolveASN = () =>
  resolveResource({
    file: 'ASN.mmdb',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb`
  })
const resolveBundleMRS = () =>
  resolveResource({
    file: 'BundleMRS.7z',
    downloadURL: `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/BundleMRS.7z`
  })
const resolveEnableLoopback = () =>
  resolveResource({
    file: 'enableLoopback.exe',
    downloadURL: `https://github.com/Kuingsmile/uwp-tool/releases/download/latest/enableLoopback.exe`
  })
/* ======= sysproxy-rs ======= */
const SYSPROXY_RS_URL_PREFIX =
  'https://github.com/mihomo-party-org/sysproxy-rs-opti/releases/latest/download'

// ELF e_machine 编号，用于校验下载的 .node 确为目标架构
const ELF_MACHINE = {
  x64: 62, // EM_X86_64
  ia32: 3, // EM_386
  arm64: 183 // EM_AARCH64
}

function assertElfMachine(filePath, targetArch) {
  const fd = fs.openSync(filePath, 'r')
  const header = Buffer.alloc(20)
  try {
    fs.readSync(fd, header, 0, 20, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (header.toString('ascii', 0, 4) !== '\x7fELF') {
    throw new Error(`not a valid ELF file: ${filePath}`)
  }
  const machine = header.readUInt16LE(18)
  const expected = ELF_MACHINE[targetArch]
  if (expected !== undefined && machine !== expected) {
    throw new Error(
      `architecture mismatch for "${filePath}": expected ${targetArch} (ELF machine ${expected}), got ${machine}`
    )
  }
}

function getSysproxyNodeName() {
  // 检测是否为 musl 系统（与 src/native/sysproxy/index.js 保持一致）
  const isMusl = (() => {
    if (platform !== 'linux') return false
    try {
      const output = execSync('ldd --version 2>&1 || true').toString()
      return output.includes('musl')
    } catch {
      return false
    }
  })()

  const isWin7Build = process.env.LEGACY_BUILD === 'true'

  switch (platform) {
    case 'win32':
      if (arch === 'x64')
        return isWin7Build ? 'sysproxy.win32-x64-msvc-win7.node' : 'sysproxy.win32-x64-msvc.node'
      if (arch === 'arm64') return 'sysproxy.win32-arm64-msvc.node'
      if (arch === 'ia32')
        return isWin7Build ? 'sysproxy.win32-ia32-msvc-win7.node' : 'sysproxy.win32-ia32-msvc.node'
      break
    case 'darwin':
      if (arch === 'x64') return 'sysproxy.darwin-x64.node'
      if (arch === 'arm64') return 'sysproxy.darwin-arm64.node'
      break
    case 'linux':
      if (isMusl) {
        if (arch === 'x64') return 'sysproxy.linux-x64-musl.node'
        if (arch === 'arm64') return 'sysproxy.linux-arm64-musl.node'
      } else {
        if (arch === 'x64') return 'sysproxy.linux-x64-gnu.node'
        if (arch === 'arm64') return 'sysproxy.linux-arm64-gnu.node'
      }
      break
  }
  throw new Error(`Unsupported platform for sysproxy-rs: ${platform}-${arch}`)
}

const resolveSysproxy = async () => {
  const nodeName = getSysproxyNodeName()
  const sidecarDir = path.join(cwd, 'extra', 'sidecar')
  const targetPath = path.join(sidecarDir, nodeName)

  fs.mkdirSync(sidecarDir, { recursive: true })

  // 清理其他平台的 .node 文件
  const files = fs.readdirSync(sidecarDir)
  for (const file of files) {
    if (file.endsWith('.node') && file !== nodeName) {
      fs.rmSync(path.join(sidecarDir, file))
      console.log(`[INFO]: removed ${file}`)
    }
  }

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath)
  }

  await downloadFile(`${SYSPROXY_RS_URL_PREFIX}/${nodeName}`, targetPath)
  // 校验 .node 确为目标架构 ELF，避免交叉编译时把宿主机架构产物误打进包（仅 Linux）
  if (platform === 'linux') {
    assertElfMachine(targetPath, arch)
  }
  console.log(`[INFO]: ${nodeName} finished`)
}

const resolveMonitor = async () => {
  const tempDir = path.join(TEMP_DIR, 'TrafficMonitor')
  const tempZip = path.join(tempDir, `${arch}.zip`)
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  await downloadFile(
    `https://github.com/mihomo-party-org/mihomo-party-run/releases/download/monitor/${arch}.zip`,
    tempZip
  )
  const zip = new AdmZip(tempZip)
  const resDir = path.join(cwd, 'extra', 'files')
  const targetPath = path.join(resDir, 'TrafficMonitor')
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true })
  }
  zip.extractAllTo(targetPath, true)

  console.log(`[INFO]: TrafficMonitor finished`)
}

const resolve7zip = () =>
  resolveResource({
    file: '7za.exe',
    downloadURL: `https://github.com/develar/7zip-bin/raw/master/win/${arch}/7za.exe`
  })
const resolveSubstore = () =>
  resolveResource({
    file: 'sub-store.bundle.cjs',
    downloadURL:
      'https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store.bundle.js'
  })
const resolveHelper = () =>
  resolveResource({
    file: 'party.mihomo.helper',
    downloadURL: `https://github.com/mihomo-party-org/mihomo-party-helper/releases/download/${arch}/party.mihomo.helper`
  })
const resolveSubstoreFrontend = async () => {
  const tempDir = path.join(TEMP_DIR, 'substore-frontend')
  const tempZip = path.join(tempDir, 'dist.zip')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  await downloadFile(
    'https://github.com/sub-store-org/Sub-Store-Front-End/releases/latest/download/dist.zip',
    tempZip
  )
  const zip = new AdmZip(tempZip)
  const resDir = path.join(cwd, 'extra', 'files')
  const targetPath = path.join(resDir, 'sub-store-frontend')
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true })
  }
  zip.extractAllTo(resDir, true)
  fs.renameSync(path.join(resDir, 'dist'), targetPath)

  console.log(`[INFO]: sub-store-frontend finished`)
}
const resolveFont = async () => {
  const targetPath = path.join(cwd, 'src', 'renderer', 'src', 'assets', 'NotoColorEmoji.ttf')

  if (fs.existsSync(targetPath)) {
    return
  }
  await downloadFile(
    'https://github.com/googlefonts/noto-emoji/raw/main/2D/fonts/NotoColorEmoji.ttf',
    targetPath
  )

  console.log(`[INFO]: NotoColorEmoji.ttf finished`)
}

const tasks = [
  { name: 'mihomo', func: () => resolveSidecar(mihomo()), retry: 5 },
  { name: 'mmdb', func: resolveMmdb, retry: 5 },
  { name: 'metadb', func: resolveMetadb, retry: 5 },
  { name: 'geosite', func: resolveGeosite, retry: 5 },
  { name: 'geoip', func: resolveGeoIP, retry: 5 },
  { name: 'asn', func: resolveASN, retry: 5 },
  { name: 'bundlemrs', func: resolveBundleMRS, retry: 5 },
  {
    name: 'font',
    func: resolveFont,
    retry: 5
  },
  {
    name: 'enableLoopback',
    func: resolveEnableLoopback,
    retry: 5,
    winOnly: true
  },
  {
    name: 'sysproxy',
    func: resolveSysproxy,
    retry: 5
  },
  {
    name: 'monitor',
    func: resolveMonitor,
    retry: 5,
    winOnly: true
  },
  {
    name: 'substore',
    func: resolveSubstore,
    retry: 5
  },
  {
    name: 'substorefrontend',
    func: resolveSubstoreFrontend,
    retry: 5
  },
  {
    name: '7zip',
    func: resolve7zip,
    retry: 5,
    winOnly: true
  },
  {
    name: 'helper',
    func: resolveHelper,
    retry: 5,
    darwinOnly: true
  }
]

async function runTask() {
  const task = tasks.shift()
  if (!task) return
  if (task.winOnly && platform !== 'win32') return runTask()
  if (task.linuxOnly && platform !== 'linux') return runTask()
  if (task.unixOnly && platform === 'win32') return runTask()
  if (task.darwinOnly && platform !== 'darwin') return runTask()

  for (let i = 0; i < task.retry; i++) {
    try {
      await task.func()
      break
    } catch (err) {
      console.error(`[ERROR]: task::${task.name} try ${i} ==`, err.message)
      if (i === task.retry - 1) {
        if (task.optional) {
          console.log(`[WARN]: Optional task::${task.name} failed, skipping...`)
          break
        } else {
          throw err
        }
      }
    }
  }
  return runTask()
}

runTask()
runTask()

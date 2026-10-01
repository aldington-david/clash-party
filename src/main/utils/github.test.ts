import { describe, expect, it, vi } from 'vitest'

const { get, stopCore, rmSync } = vi.hoisted(() => ({
  get: vi.fn(), stopCore: vi.fn(), rmSync: vi.fn()
}))
vi.mock('./chromeRequest', () => ({ get }))
vi.mock('../core/manager', () => ({ stopCore }))
vi.mock('../config', () => ({ getAppConfig: async () => ({ githubProxy: 'https://mirror.invalid' }) }))
vi.mock('./dirs', () => ({ mihomoCoreDir: () => 'isolated-core' }))
vi.mock('./logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()), existsSync: () => true, rmSync }))
vi.mock('fs/promises', () => ({ writeFile: vi.fn(), readFile: async () => Buffer.from('wrong archive') }))
vi.mock('os', () => ({ platform: () => 'linux' }))

describe('fork core integrity', () => {
  it('uses direct release checksums and rejects a mirror mismatch before stopping or replacing the core', async () => {
    get.mockImplementation(async (url: string) => ({
      status: 200,
      data: url.endsWith('sha256sum.txt')
        ? `${'0'.repeat(64)}  mihomo-linux-amd64-compatible-v1.19.32.gz\n`
        : Buffer.from('wrong archive')
    }))
    const { installMihomoCore } = await import('./github')
    await expect(installMihomoCore('v1.19.32')).rejects.toThrow('Core checksum mismatch')
    expect(get.mock.calls[0][0]).toMatch(/^https:\/\/mirror\.invalid\//)
    expect(get.mock.calls[1][0]).toBe('https://github.com/aldington-david/mihomo/releases/download/v1.19.32/sha256sum.txt')
    expect(stopCore).not.toHaveBeenCalled()
    expect(rmSync.mock.calls.every(([path]) => String(path).includes('temp-core.'))).toBe(true)
  })
})

// 不用 pnpm，把本插件挂进一个 DSH profile：
//   1. $DSH_HOME/profiles/<名>/node_modules/perturbpilot 链到本目录（Windows 上是 junction）；
//   2. profile 的 package.json 里加上依赖，并把 bundles 设成 web 模板 + perturbpilot。
// 效果和 `dsh plugin --profile <名> add <本目录>` 一样，只是不经过 pnpm。
// 用法：node scripts/link-profile.js [profile 名，默认 perturbpilot]
// profile 目录要先存在（`dsh plugin --profile <名> version-exemptions` 会建一个空的）。

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'perturbpilot']

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.argv[2] ?? 'perturbpilot'
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dir = join(home, 'profiles', profile)
const manifestPath = join(dir, 'package.json')

if (!existsSync(manifestPath)) {
  console.error(`没有找到 ${manifestPath}；先运行 dsh plugin --profile ${profile} version-exemptions 建 profile`)
  process.exit(1)
}

const link = join(dir, 'node_modules', 'perturbpilot')
mkdirSync(dirname(link), { recursive: true })
let linked = false
try {
  linked = lstatSync(link).isSymbolicLink()
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (!linked) {
  if (existsSync(link)) {
    console.error(`${link} 已存在且不是链接，请手动处理`)
    process.exit(1)
  }
  symlinkSync(pluginDir, link, 'junction')
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = { ...manifest.dependencies, perturbpilot: `link:${pluginDir.split('\\').join('/')}` }
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: BUNDLES } }
writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')

console.log(`已把 ${pluginDir} 挂进 profile ${profile}（${dir}）`)

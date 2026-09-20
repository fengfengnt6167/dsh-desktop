import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entryPackage = '@linxin666/dsh-web-all'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function localDependencyClosure(packages, entry = entryPackage) {
  const selected = new Set()
  function visit(name) {
    if (selected.has(name)) return
    const manifest = packages.get(name)
    if (!manifest) throw new Error(`Missing workspace package: ${name}`)
    if (manifest.private) throw new Error(`Cannot bundle private runtime package: ${name}`)
    selected.add(name)
    for (const [dependency, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (packages.has(dependency)) visit(dependency)
      else if (range.startsWith('workspace:')) throw new Error(`Missing workspace dependency: ${dependency}`)
    }
  }
  visit(entry)
  return [...selected].sort()
}

export function artifactFilename(name, bytes) {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${hash(bytes)}.tgz`
}

export function updateLocalDependencies(root, desktops, artifacts, previous = {}) {
  root.resolutions ??= {}
  for (const item of previous.packages ?? []) {
    if (root.resolutions[item.name] === `file:vendor/dsh-web/${item.artifact}`) delete root.resolutions[item.name]
  }
  for (const item of artifacts) root.resolutions[item.name] = `file:vendor/dsh-web/${item.artifact}`
  const entry = artifacts.find(item => item.name === entryPackage)
  if (!entry) throw new Error(`Missing artifact: ${entryPackage}`)
  for (const desktop of desktops) {
    desktop.dependencies ??= {}
    desktop.dependencies[entryPackage] = `file:../vendor/dsh-web/${entry.artifact}`
  }
}

function writeJson(path, value) {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const newline = previous.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`.replaceAll('\n', newline))
}

function prepare() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const source = resolve(root, process.env.DSH_WEB_SOURCE ?? '../dsh-web')
  const pnpm = process.env.COREPACK_ROOT && join(process.env.COREPACK_ROOT, 'dist', 'pnpm.js')
  if (!pnpm || !existsSync(pnpm)) throw new Error('Run this script through corepack yarn plugins:prepare')
  const packages = new Map()
  const directories = new Map()
  for (const parent of ['packages', 'packages/skins']) {
    const directory = join(source, parent)
    if (!existsSync(directory)) continue
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const packageDirectory = join(directory, child.name)
      const manifestPath = join(packageDirectory, 'package.json')
      if (!child.isDirectory() || !existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath)
      if (packages.has(manifest.name)) throw new Error(`Duplicate workspace package: ${manifest.name}`)
      packages.set(manifest.name, manifest)
      directories.set(manifest.name, packageDirectory)
    }
  }
  const selected = localDependencyClosure(packages)
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', timeout: 60_000 }).trim()
  const commit = git(['rev-parse', 'HEAD'])
  const dirty = git(['status', '--porcelain']).length > 0
  const vendor = join(root, 'vendor/dsh-web')
  const provenancePath = join(vendor, 'provenance.json')
  const previous = existsSync(provenancePath) ? readJson(provenancePath) : {}
  const stagingParent = join(root, '.build')
  mkdirSync(stagingParent, { recursive: true })
  const staging = mkdtempSync(join(stagingParent, 'dsh-web-pack-'))
  mkdirSync(vendor, { recursive: true })
  const artifacts = []
  for (const [index, name] of selected.entries()) {
    const destination = join(staging, String(index))
    mkdirSync(destination)
    console.log(`Packing ${name}`)
    const result = spawnSync(process.execPath, [pnpm, '--filter', name, 'pack', '--pack-destination', destination], {
      cwd: source, env: process.env, stdio: 'inherit', timeout: 600_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`pnpm pack failed for ${name}: ${result.status}`)
    const tarballs = readdirSync(destination).filter(file => file.endsWith('.tgz'))
    if (tarballs.length !== 1) throw new Error(`Expected one tarball for ${name}, got ${tarballs.length}`)
    const packed = join(destination, tarballs[0])
    const bytes = readFileSync(packed)
    const artifact = artifactFilename(name, bytes)
    copyFileSync(packed, join(vendor, artifact))
    artifacts.push({ name, version: packages.get(name).version, directory: relative(source, directories.get(name)).replaceAll('\\', '/'), artifact, sha256: hash(bytes) })
  }
  const manifestPaths = ['package.json', 'dsh-plugin-desktop/package.json', 'dsh-plugin-desktop-beta/package.json'].map(path => join(root, path))
  const manifests = manifestPaths.map(readJson)
  updateLocalDependencies(manifests[0], manifests.slice(1), artifacts, previous)
  for (const [index, manifest] of manifests.entries()) writeJson(manifestPaths[index], manifest)
  writeJson(provenancePath, { commit, dirty, packages: artifacts })
  console.log(`Prepared ${artifacts.length} local plugins from ${commit}${dirty ? ' (with local changes)' : ''}. Run corepack yarn install next.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { prepare() } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

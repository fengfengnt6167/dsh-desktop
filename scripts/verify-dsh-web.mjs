/** Verify local plugin artifacts and their installed runtime faces without launching the app. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor/dsh-web')
const source = resolve(process.env.DSH_WEB_SOURCE ?? join(root, '../dsh-web'))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function containedPath(target, path) {
  const physical = realpathSync(path)
  const rel = relative(target, physical)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Runtime file resolves outside ${target}: ${physical}. Workspace-hoisted or linked dependencies cannot prove a self-contained app.`)
  }
  return physical
}

function packageRoot(entry, name) {
  let directory = dirname(entry)
  while (true) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && readJson(manifest).name === name) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot find package manifest for ${name}: ${entry}`)
    directory = parent
  }
}

function sameBytes(sourcePath, installedPath, label) {
  if (hash(sourcePath) !== hash(installedPath)) {
    throw new Error(`${label} differs from the built source: ${installedPath}`)
  }
}

try {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/verify-dsh-web.mjs [application-root]')
  const provenance = readJson(join(vendor, 'provenance.json'))
  if (!Array.isArray(provenance.packages) || provenance.packages.length === 0) {
    throw new Error('No plugin artifacts in vendor/dsh-web/provenance.json')
  }
  for (const item of provenance.packages) {
    if (hash(join(vendor, item.artifact)) !== item.sha256) {
      throw new Error(`Artifact SHA256 mismatch: ${item.artifact}`)
    }
  }
  const targets = process.argv[2]
    ? [resolve(process.argv[2])]
    : ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta'].map(name => join(root, name))
  for (const candidate of targets) {
    const target = realpathSync(candidate)
    const require = createRequire(join(target, 'package.json'))
    for (const item of provenance.packages) {
      const sourceRoot = join(source, item.directory)
      const sourceManifest = readJson(join(sourceRoot, 'package.json'))
      const entry = containedPath(target, require.resolve(item.name))
      const installedRoot = packageRoot(entry, item.name)
      const installedManifest = readJson(containedPath(target, join(installedRoot, 'package.json')))
      if (sourceManifest.name !== item.name || sourceManifest.version !== item.version || installedManifest.version !== item.version) {
        throw new Error(`Source/provenance/installed package version mismatch: ${item.name}`)
      }
      if (!sourceManifest.main) throw new Error(`Missing source main entry: ${item.name}`)
      sameBytes(join(sourceRoot, sourceManifest.main), entry, `${item.name} main`)
      const client = sourceManifest.exports?.['./client']
      const clientPath = typeof client === 'string' ? client : client?.default
      if (client !== undefined && !clientPath) throw new Error(`Unsupported client export: ${item.name}`)
      if (clientPath) {
        sameBytes(join(sourceRoot, clientPath), containedPath(target, require.resolve(`${item.name}/client`)), `${item.name} client`)
      }
      const patch = sourceManifest.dsh?.bundle?.patch
      if (patch) {
        if (installedManifest.dsh?.bundle?.patch !== patch) throw new Error(`Bundle patch declaration mismatch: ${item.name}`)
        sameBytes(join(sourceRoot, patch), containedPath(target, join(installedRoot, patch)), `${item.name} patch`)
      }
    }
    console.log(`verify-dsh-web: ${provenance.packages.length} local plugins match built main/client/patch files inside ${target}`)
  }
} catch (error) {
  console.error(`verify-dsh-web: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

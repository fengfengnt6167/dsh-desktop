import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactFilename, localDependencyClosure, updateLocalDependencies } from './prepare-dsh-web.mjs'

test('selects transitive production and optional plugins, including cycles, without dev or unrelated packages', () => {
  const packages = new Map([
    ['all', { dependencies: { plugin: 'workspace:*', external: '^1' }, devDependencies: { tooling: '*' } }],
    ['plugin', { optionalDependencies: { skin: '*' }, peerDependencies: { tooling: '*' } }],
    ['skin', { dependencies: { all: '*' } }],
    ['tooling', { private: true }],
    ['unrelated', {}],
  ])
  assert.deepEqual(localDependencyClosure(packages, 'all'), ['all', 'plugin', 'skin'])
})

test('fails for missing workspace dependencies and private runtime packages', () => {
  assert.throws(() => localDependencyClosure(new Map([['all', { dependencies: { missing: 'workspace:*' } }]]), 'all'), /missing/)
  assert.throws(() => localDependencyClosure(new Map([['all', { private: true }]]), 'all'), /private/)
})

test('content-addressed names change when bytes change, even at the same version', () => {
  const name = artifactFilename('@scope/plugin', Buffer.from('one'))
  assert.equal(name, artifactFilename('@scope/plugin', Buffer.from('one')))
  assert.notEqual(name, artifactFilename('@scope/plugin', Buffer.from('two')))
  assert.match(name, /^scope-plugin-[a-f0-9]{64}\.tgz$/)
})

test('maps all local artifacts, updates both desktop channels and removes only owned stale resolutions', () => {
  const root = { resolutions: { stale: 'file:vendor/dsh-web/old.tgz', retained: 'custom', external: '1' } }
  const desktops = [{ dependencies: { existing: '1' } }, {}]
  const previous = { packages: [{ name: 'stale', artifact: 'old.tgz' }, { name: 'retained', artifact: 'prior.tgz' }] }
  const artifacts = [{ name: '@linxin666/dsh-web-all', artifact: 'all.tgz' }, { name: 'plugin', artifact: 'plugin.tgz' }]
  updateLocalDependencies(root, desktops, artifacts, previous)
  assert.deepEqual(root.resolutions, { retained: 'custom', external: '1', '@linxin666/dsh-web-all': 'file:vendor/dsh-web/all.tgz', plugin: 'file:vendor/dsh-web/plugin.tgz' })
  for (const desktop of desktops) assert.equal(desktop.dependencies['@linxin666/dsh-web-all'], 'file:../vendor/dsh-web/all.tgz')
  assert.equal(desktops[0].dependencies.existing, '1')
})

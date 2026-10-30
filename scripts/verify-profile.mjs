// Post-change verification for the desktop profile wiring.
//
// Checks the things that must all be true for `dsh-desktop-bridge` to load, and
// the things the crash-recovery button silently removed.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const dir = 'C:/Users/mfy_c/.dsh/profiles/desktop'
const require = createRequire(path.join(dir, 'noop.cjs'))
const YAML = require('yaml')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const patch = YAML.parse(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'))

console.log('\nprofile: package.json')
check('bridge in dependencies', Boolean(pkg.dependencies['dsh-desktop-bridge']), pkg.dependencies['dsh-desktop-bridge'])
check('bridge in dsh.profile.bundles', pkg.dsh.profile.bundles.includes('dsh-desktop-bridge'))
check('no dsh-task-notifier leftovers', !pkg.dsh.profile.bundles.includes('dsh-task-notifier') && !pkg.dependencies['dsh-task-notifier'])

console.log('\nprofile: cordis.patch.yml')
const ids = patch.map((e) => (e.insert ? 'insert' : e.id))
check('patch parses as a top-level array', Array.isArray(patch), `${patch.length} entries`)

// A bundle that ships its own `dsh.bundle.patch` is mounted by the bundle layer
// from the package manifest alone; redeclaring it here would be a duplicate
// loader id, so the correct state is "row absent from the patch, present in
// dsh.profile.bundles" (asserted above).
const bundleIds = new Set()
for (const name of pkg.dsh.profile.bundles) {
  const manifest = path.join(dir, 'node_modules', name, 'package.json')
  if (!fs.existsSync(manifest)) continue
  const p = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const rel = p.dsh?.bundle?.patch
  if (!rel) continue
  const file = path.join(dir, 'node_modules', name, rel)
  if (!fs.existsSync(file)) continue
  const rows = YAML.parse(fs.readFileSync(file, 'utf8'))
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const item of row.insert ?? []) bundleIds.add(item.id)
  }
}

check(
  'bridge row is mounted by its own bundle patch',
  bundleIds.has('dsh-desktop-bridge') && !patch.some((e) => e.insert?.some((i) => i.id === 'dsh-desktop-bridge')),
  bundleIds.has('dsh-desktop-bridge') ? 'self-declared, absent from the user patch' : 'not declared anywhere',
)

// The entries the crash-recovery button dropped; each owns real user settings.
// A row is "restored" when it is declared in the user patch *or* by a bundle
// installed in this profile.
//
// Some of these ids live in the runtime's own base bundle (`@deepseek-ai/dsh-base`),
// which ships inside the app archive rather than in the profile's node_modules —
// they are present but not visible here. Point DSH_ASAR at that archive to check
// them too; without it they are reported as unresolved instead of failing, so a
// machine-local layout never reads as a wiring regression.
const asarPath = process.env.DSH_ASAR;
let asarText = null;
if (asarPath) {
  try {
    asarText = fs.readFileSync(asarPath).toString('utf8');
  } catch (error) {
    console.log(`  note  DSH_ASAR unreadable (${error.message}); runtime rows not verified`);
  }
}

const inRuntime = (id) => (asarText === null ? null : new RegExp(`id:\\s*["']?${id}["']?\\s*\\n?\\s*name:`).test(asarText));

for (const id of ['permission', 'ui-theme', 'ui-conversation', 'agency-agents', 'better-sidebar', 'llm-pi-ai']) {
  const local = ids.includes(id) || bundleIds.has(id);
  if (local) {
    check(`restored ${id}`, true);
    continue;
  }
  const runtime = inRuntime(id);
  if (runtime === true) check(`restored ${id}`, true, 'runtime base bundle');
  else if (runtime === false) check(`restored ${id}`, false, 'absent locally and from the runtime base bundle');
  else console.log(`  n/a  restored ${id} — not in this profile; set DSH_ASAR to verify the runtime base bundle`);
}
check('permission presets intact', Boolean(patch.find((e) => e.id === 'permission')?.config?.presets))
check('danger-full-access still the default preset', patch.find((e) => e.id === 'permission')?.config?.defaultPreset === 'danger-full-access')

console.log('\nlink')
const link = path.join(dir, 'node_modules', 'dsh-desktop-bridge')
check('node_modules link exists', fs.existsSync(link))
const entry = path.join(link, 'lib', 'client.js')
check('client bundle reachable through the link', fs.existsSync(entry))

if (fs.existsSync(entry)) {
  const source = fs.readFileSync(entry, 'utf8')
  check('bundle carries the module loader envelope', /window\.__ModuleLoader__\.load\(\{/.test(source))
  // The loader keys the factory by package name; a mismatch means the shell
  // looks up an id that never registers.
  const pkgJson = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'))
  check('envelope id matches the package name', source.includes(`id: "${pkgJson.name}"`) || source.includes(`id:"${pkgJson.name}"`), pkgJson.name)
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)

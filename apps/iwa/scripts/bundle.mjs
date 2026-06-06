// Packages the Vite build output into a signed Isolated Web App (.swbn)
// Requires: npm install -g wbn-sign wbn
// Run after: pnpm build

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')
const dist = resolve(root, 'dist')
const keyFile = resolve(root, 'iwa-key.pem')
const outFile = resolve(root, 'moonlight.swbn')

if (!existsSync(dist)) {
  console.error('Run pnpm build first')
  process.exit(1)
}

// Generate signing key if not present
if (!existsSync(keyFile)) {
  console.log('Generating IWA signing key…')
  execSync(`openssl genpkey -algorithm ed25519 -out ${keyFile}`)
  console.log(`Key written to ${keyFile} — keep this secret!`)
}

// Bundle as unsigned web bundle first
const unsignedFile = resolve(root, 'moonlight.wbn')
console.log('Bundling…')
execSync(
  `wbn-bundle --baseURL isolated-app://$(wbn-key-id ${keyFile})/ --primaryURL isolated-app://$(wbn-key-id ${keyFile})/ --output ${unsignedFile} --dir ${dist}`,
  { stdio: 'inherit' },
)

// Sign the bundle
console.log('Signing…')
execSync(
  `wbn-sign --private-key ${keyFile} --input ${unsignedFile} --output ${outFile}`,
  { stdio: 'inherit' },
)

console.log(`\nDone: ${outFile}`)
console.log('Install via chrome://apps → Developer mode → Load web bundle')

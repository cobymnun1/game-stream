#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const vendorRoot = resolve(packageRoot, 'vendor')
const checkoutPath = resolve(vendorRoot, 'moonlight-common-c')

const repo = 'https://github.com/moonlight-stream/moonlight-common-c.git'
const ref = process.env.MOONLIGHT_COMMON_C_REF ?? '2600beaf13f18bfa43453609cf5e3b84a4227760'

if (existsSync(checkoutPath)) {
  console.log(`moonlight-common-c already exists at ${checkoutPath}`)
  console.log('Remove it first if you intentionally want to fetch a different revision.')
  process.exit(0)
}

await mkdir(vendorRoot, { recursive: true })

run('git', ['clone', repo, checkoutPath])
run('git', ['checkout', ref], { cwd: checkoutPath })
run('git', ['submodule', 'update', '--init', '--recursive'], { cwd: checkoutPath })

console.log(`Fetched moonlight-common-c at ${ref}`)
console.log('License: GPL-3.0. Distributing the resulting WASM/client must comply with GPL-3.0 obligations.')

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    stdio: 'inherit',
  })
}

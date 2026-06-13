import { createRuntimeTransport } from './transport.js'
import type {
  MoonlightCallbacks,
  MoonlightModuleFactory,
  MoonlightRuntimeTransport,
  MoonlightWasmModule,
  TransportFactory,
} from './types.js'

export interface LoadMoonlightModuleOptions {
  moduleFactory?: MoonlightModuleFactory
  moduleUrl?: string
  transport: TransportFactory
  callbacks?: MoonlightCallbacks
  locateFile?: (path: string, prefix: string) => string
}

export async function loadMoonlightModule(options: LoadMoonlightModuleOptions): Promise<MoonlightWasmModule> {
  const factory = options.moduleFactory ?? await importModuleFactory(options.moduleUrl ?? './moonlight.js')
  const runtimeTransport = createRuntimeTransport(options.transport)
  const moduleOptions: Record<string, unknown> = {
    moonlightTransport: runtimeTransport,
  }

  if (options.callbacks) moduleOptions['moonlightCallbacks'] = options.callbacks
  if (options.locateFile) moduleOptions['locateFile'] = options.locateFile

  const module = await factory(moduleOptions)
  module.moonlightTransport = runtimeTransport
  if (options.callbacks) module.moonlightCallbacks = options.callbacks
  return module
}

async function importModuleFactory(moduleUrl: string): Promise<MoonlightModuleFactory> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>
  const loaded = await dynamicImport(moduleUrl)
  const factory = loaded['default'] ?? loaded['MoonlightModule']

  if (typeof factory !== 'function') {
    throw new Error(`Moonlight WASM module at ${moduleUrl} did not export a module factory`)
  }

  return factory as MoonlightModuleFactory
}

export type { MoonlightRuntimeTransport }

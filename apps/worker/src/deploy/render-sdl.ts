import { generateManifest, yaml } from "@akashnetwork/chain-sdk";
import { GPU_CATALOG, type GpuId } from "@basehack/shared";
import Handlebars from "handlebars";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDL_TEMPLATE_PATH = join(__dirname, "../../../../sdl/sunshine-stream.yaml");

export interface SdlTemplateVars {
  sunshineImage: string;
  cpuUnits: number;
  memoryGb: string;
  gpuModel: string;
  gpuRam: string;
  maxUaktPerBlock: number;
  ipLeaseUaktPerBlock: number;
}

export function buildSdlVars(params: {
  gpuId: GpuId;
  cpuUnits: number;
  memoryGb: number;
  maxUaktPerBlock: number;
  ipLeaseUaktPerBlock: number;
}): SdlTemplateVars {
  const gpu = GPU_CATALOG[params.gpuId];
  return {
    sunshineImage:
      process.env.SUNSHINE_IMAGE ?? "cobymnun/game-stream-container:latest",
    cpuUnits: params.cpuUnits,
    memoryGb: `${params.memoryGb}Gi`,
    gpuModel: gpu.model,
    gpuRam: gpu.ram,
    maxUaktPerBlock: params.maxUaktPerBlock,
    ipLeaseUaktPerBlock: params.ipLeaseUaktPerBlock,
  };
}

let compiledTemplate: HandlebarsTemplateDelegate | null = null;

async function getTemplate(): Promise<HandlebarsTemplateDelegate> {
  if (!compiledTemplate) {
    const raw = await readFile(SDL_TEMPLATE_PATH, "utf8");
    compiledTemplate = Handlebars.compile(raw, { noEscape: true });
  }
  return compiledTemplate;
}

export async function renderSdl(vars: SdlTemplateVars): Promise<string> {
  const template = await getTemplate();
  return template(vars);
}

export async function validateAndParseSdl(yamlContent: string) {
  const sdl = yaml.raw(yamlContent);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manifest = (generateManifest as any)(sdl, "mainnet") as ReturnType<typeof generateManifest>;
  if (!manifest.ok) {
    throw new Error(
      `SDL validation failed: ${JSON.stringify(manifest.value)}`
    );
  }
  return manifest.value;
}

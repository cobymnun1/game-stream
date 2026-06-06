export type GpuId = "rtx3090" | "rtx4070" | "rtx4090" | "rtx5090";

export interface GpuSpec {
  id: GpuId;
  label: string;
  model: string;
  ram: string;
  interface: "pcie";
}

export const GPU_CATALOG: Record<GpuId, GpuSpec> = {
  rtx3090: {
    id: "rtx3090",
    label: "RTX 3090",
    model: "rtx3090",
    ram: "24Gi",
    interface: "pcie",
  },
  rtx4070: {
    id: "rtx4070",
    label: "RTX 4070",
    model: "rtx4070",
    ram: "12Gi",
    interface: "pcie",
  },
  rtx4090: {
    id: "rtx4090",
    label: "RTX 4090",
    model: "rtx4090",
    ram: "24Gi",
    interface: "pcie",
  },
  rtx5090: {
    id: "rtx5090",
    label: "RTX 5090",
    model: "rtx5090",
    ram: "32Gi",
    interface: "pcie",
  },
};

export const GPU_OPTIONS = Object.values(GPU_CATALOG);

export const CPU_MIN = 8;
export const CPU_MAX = 32;
export const RAM_MIN_GB = 16;
export const RAM_MAX_GB = 64;
export const STORAGE_GB = 128;

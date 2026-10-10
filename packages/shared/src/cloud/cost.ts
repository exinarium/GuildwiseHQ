/**
 * Cloud workstation costs (docs/design/cloud-workstations-and-forges.md, part 1). The user pays their own provider
 * (GitHub for Codespaces, the VPS company for a VPS); Guildwise charges nothing extra. These are estimates shown in
 * the app, never a bill. Prices as of 2026-10-10.
 */

export interface CodespacesMachine {
  /** GitHub's machine name. */
  name: string;
  label: string;
  cores: number;
  memoryGb: number;
  storageGb: number;
  /** USD per hour while running. */
  hourlyUsd: number;
}

/** GitHub Codespaces list prices (compute per hour). */
export const CODESPACES_MACHINES: readonly CodespacesMachine[] = [
  { name: 'basicLinux32gb', label: '2 cores, 8 GB RAM, 32 GB disk', cores: 2, memoryGb: 8, storageGb: 32, hourlyUsd: 0.18 },
  { name: 'standardLinux32gb', label: '4 cores, 16 GB RAM, 32 GB disk', cores: 4, memoryGb: 16, storageGb: 32, hourlyUsd: 0.36 },
  { name: 'premiumLinux', label: '8 cores, 32 GB RAM, 64 GB disk', cores: 8, memoryGb: 32, storageGb: 64, hourlyUsd: 0.72 },
  { name: 'largePremiumLinux', label: '16 cores, 64 GB RAM, 128 GB disk', cores: 16, memoryGb: 64, storageGb: 128, hourlyUsd: 1.44 },
];

/** Storage is charged while the codespace exists, stopped or not. */
export const CODESPACES_STORAGE_USD_PER_GB_MONTH = 0.07;
/** Free core-hours a month on a personal GitHub account (Free plan). */
export const CODESPACES_FREE_CORE_HOURS = 120;

export const machineByName = (name: string): CodespacesMachine | undefined =>
  CODESPACES_MACHINES.find((m) => m.name === name);

export interface CostEstimate {
  /** US dollars, rounded to cents. */
  monthlyUsd: number;
  /** One plain sentence on how the number was made. */
  basis: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A VPS bills a flat monthly price whether or not agents work. Codespaces bill compute only while running, so the
 * estimate multiplies the hours a month the machine is expected to run (office hours, else a working month) and adds
 * storage.
 */
export function estimateMonthlyCost(
  input:
    | { provider: 'ssh'; monthlyPriceUsd: number | null }
    | { provider: 'codespaces'; machine: string; hoursPerMonth: number; storageGb?: number },
): CostEstimate {
  if (input.provider === 'ssh') {
    if (input.monthlyPriceUsd === null)
      return {
        monthlyUsd: 0,
        basis: 'Enter what your VPS costs a month to see an estimate. You pay your VPS company directly.',
      };
    return {
      monthlyUsd: round2(input.monthlyPriceUsd),
      basis:
        'A VPS costs the same every month, whether or not agents are working. You pay your VPS company directly.',
    };
  }
  const m = machineByName(input.machine);
  if (!m) return { monthlyUsd: 0, basis: 'Unknown machine type.' };
  const storage = (input.storageGb ?? m.storageGb) * CODESPACES_STORAGE_USD_PER_GB_MONTH;
  const compute = m.hourlyUsd * input.hoursPerMonth;
  return {
    monthlyUsd: round2(compute + storage),
    basis: `About ${Math.round(input.hoursPerMonth)} running hours a month at $${m.hourlyUsd.toFixed(2)} an hour, plus disk. You pay GitHub directly; a personal account includes ${CODESPACES_FREE_CORE_HOURS} free core-hours a month.`,
  };
}

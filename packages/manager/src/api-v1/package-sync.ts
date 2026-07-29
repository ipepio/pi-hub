/**
 * Diff puro entre el conjunto de paquetes instalado y el deseado (spec §1.3:
 * `PUT /agents/:name/packages` recibe el conjunto COMPLETO, no altas/bajas
 * sueltas). La ruta aplica `toInstall`/`toRemove` con `piInstall`/`piRemove`
 * (subproceso real de `pi`, `packages/shared/src/pi.ts`) — eso no se prueba
 * aquí ni con unitarios (necesita el binario `pi` y red), se verifica con
 * `contract-red` contra el Manager real (§1.5).
 */
export function diffPackages(
  current: string[],
  desired: string[],
): { toInstall: string[]; toRemove: string[] } {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    toInstall: desired.filter((source) => !currentSet.has(source)),
    toRemove: current.filter((source) => !desiredSet.has(source)),
  };
}

import { formatAppBaseName, formatConnectName } from "@t3tools/contracts";

let appBaseName = formatAppBaseName(null);

export function setAppBaseName(next: string): void {
  appBaseName = next;
}

export function getAppBaseName(): string {
  return appBaseName;
}

export function getConnectName(): string {
  return formatConnectName(appBaseName);
}

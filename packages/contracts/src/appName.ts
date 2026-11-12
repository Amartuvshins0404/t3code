export function formatAppBaseName(ownerName: string | null | undefined): string {
  const name = ownerName?.trim() ?? "";
  return name.length > 0 ? `${name} Mode` : "Mode";
}

export function resolveAppMonogram(ownerName: string | null | undefined): string {
  const [first] = ownerName?.trim() ?? "";
  return (first ?? "M").toLocaleUpperCase();
}

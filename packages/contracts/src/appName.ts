export function formatAppBaseName(ownerName: string | null | undefined): string {
  const name = ownerName?.trim() ?? "";
  return name.length > 0 ? `${name} Mode` : "Mode";
}

export function resolveAppMonogram(ownerName: string | null | undefined): string {
  const [first] = ownerName?.trim() ?? "";
  return (first ?? "M").toLocaleUpperCase();
}

const UPSTREAM_APP_IDENTITY = {
  bundleId: "com.t3tools.t3code",
  packageName: "t3code",
  scheme: "t3code",
  developmentScheme: "t3code-dev",
  userDataDirName: "t3code-v2",
  developmentUserDataDirName: "t3code-dev",
  homeDirName: ".t3",
};

export type AppIdentity = typeof UPSTREAM_APP_IDENTITY;

export function resolveAppIdentity(ownerName: string | null | undefined): AppIdentity {
  if (!ownerName?.trim()) return UPSTREAM_APP_IDENTITY;
  const slug = formatAppBaseName(ownerName)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return {
    bundleId: `${UPSTREAM_APP_IDENTITY.bundleId}.${slug}`,
    packageName: slug,
    scheme: slug,
    developmentScheme: `${slug}-dev`,
    userDataDirName: slug,
    developmentUserDataDirName: `${slug}-dev`,
    homeDirName: `.t3-${slug}`,
  };
}

export function isAppLinkProtocol(protocol: string): boolean {
  return /^(?:t3code|[a-z0-9-]*mode)(?:-[a-z]+)?:$/.test(protocol);
}

export function resolveAppSchemes(ownerName: string | null | undefined): readonly string[] {
  const owner = resolveAppIdentity(ownerName);
  return [
    ...new Set([
      UPSTREAM_APP_IDENTITY.scheme,
      UPSTREAM_APP_IDENTITY.developmentScheme,
      owner.scheme,
      owner.developmentScheme,
    ]),
  ];
}

const NIGHTLY_SERVER_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveHostedAppChannelLabel(channel: string | null | undefined): string | null {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "nightly" ? "Nightly" : normalized === "latest" ? "Latest" : null;
}

/** Stage label of a web build. vite.config.ts stamps it into index.html's title too. */
export function resolveWebAppStageLabel(input: {
  readonly hostedAppChannel: string | null | undefined;
  readonly development: boolean;
}): string {
  return (
    resolveHostedAppChannelLabel(input.hostedAppChannel) ?? (input.development ? "Dev" : "Beta")
  );
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

/**
 * Names the open thread: `project / thread` on desktop, where the OS already
 * shows the app, with the app name appended in browser tabs.
 */
export function resolveWindowTitle(input: {
  readonly appDisplayName: string;
  readonly projectTitle: string | null;
  readonly threadTitle: string | null;
  readonly desktop: boolean;
}): string {
  const threadTitle = input.threadTitle?.trim() ?? "";
  if (threadTitle === "") {
    return input.appDisplayName;
  }

  const projectTitle = input.projectTitle?.trim() ?? "";
  const context = projectTitle === "" ? threadTitle : `${projectTitle} / ${threadTitle}`;
  return input.desktop ? context : `${context} - ${input.appDisplayName}`;
}

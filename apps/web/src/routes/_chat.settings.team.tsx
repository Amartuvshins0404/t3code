import { createFileRoute, redirect } from "@tanstack/react-router";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { TeamSettingsPanel } from "../components/settings/TeamSettings";

export const Route = createFileRoute("/_chat/settings/team")({
  beforeLoad: () => {
    if (!hasCloudPublicConfig()) throw redirect({ to: "/settings/general", replace: true });
  },
  component: TeamSettingsPanel,
});

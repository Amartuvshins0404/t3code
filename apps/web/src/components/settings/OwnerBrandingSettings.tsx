import { useAtomValue } from "@effect/atom-react";

import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerConfigAtom } from "../../state/server";
import { OwnerLogoPicker, OwnerNameInput } from "../OwnerBranding";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function OwnerBrandingSettings() {
  const config = useAtomValue(primaryServerConfigAtom);
  const updateSettings = useUpdatePrimarySettings();
  if (config?.environment.capabilities.ownerBranding !== true) return null;
  const { ownerName, ownerLogo } = config.settings;
  return (
    <SettingsSection id="your-mode" title="Your mode">
      <SettingsRow
        {...searchableSetting("owner-name")}
        description='The app is called "<your name> Mode". Leave empty for plain "Mode".'
        control={
          <OwnerNameInput
            className="w-full sm:w-56"
            value={ownerName}
            onCommit={(next) => updateSettings({ ownerName: next })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("owner-logo")}
        description="Shown next to the name. Without one, the first letter of your name is used."
        control={
          <OwnerLogoPicker
            logo={ownerLogo}
            ownerName={ownerName}
            onChange={(next) => updateSettings({ ownerLogo: next })}
          />
        }
      />
    </SettingsSection>
  );
}

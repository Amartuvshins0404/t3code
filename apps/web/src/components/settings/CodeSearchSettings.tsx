import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { CodeSearchSetup, codeSearchStatusLabel, useCodeSearchStatus } from "../CodeSearchSetup";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CodeSearchSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .codeSearchSetup === true;
  if (!supported) return null;
  return <CodeSearchSettingsRow environmentId={environmentId} />;
}

function CodeSearchSettingsRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const status = useCodeSearchStatus(environmentId);
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title="Code search">
      <SettingsRow
        {...searchableSetting("code-search")}
        description={`Lets agents search code by meaning. ${codeSearchStatusLabel(status)}.`}
        control={
          <Button size="xs" variant="outline" onClick={() => setOpen((next) => !next)}>
            {open ? "Done" : status?.provider === undefined ? "Set up" : "Change key"}
          </Button>
        }
      >
        {open ? <CodeSearchSetup environmentId={environmentId} /> : null}
      </SettingsRow>
    </SettingsSection>
  );
}

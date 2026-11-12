import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

/** Shown when the relay refuses a new tunnel because the account is at its cap. */
export function TunnelLimitAlert({
  onManageTunnels,
}: {
  readonly onManageTunnels: (() => void) | null;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>You&apos;re out of tunnels.</AlertTitle>
      <AlertDescription>
        Switch to Tailscale or deregister an environment you no longer use.
      </AlertDescription>
      {onManageTunnels ? (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onManageTunnels}>
            Manage tunnels
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

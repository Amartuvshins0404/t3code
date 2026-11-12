import { CircleUserRoundIcon, LogInIcon } from "lucide-react";

import { useCloudAuth } from "../../cloud/cloudAuth";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { openCloudSignInDialog } from "../../cloud/cloudSignInPrompt";
import { openT3ConnectAccountPage } from "./T3ConnectAccountDialog";

export function T3ConnectSidebarAccount() {
  const { isLoaded, isSignedIn, user } = useCloudAuth();
  if (!hasCloudPublicConfig() || !isLoaded) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {isSignedIn && user ? (
          <SidebarMenuButton onClick={() => openT3ConnectAccountPage()}>
            {user.image ? (
              <img src={user.image} alt="" className="size-4 rounded-full" />
            ) : (
              <CircleUserRoundIcon />
            )}
            <span className="truncate">{user.name || user.email}</span>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuButton onClick={openCloudSignInDialog}>
            <LogInIcon />
            <span>Sign in to T3 Connect</span>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

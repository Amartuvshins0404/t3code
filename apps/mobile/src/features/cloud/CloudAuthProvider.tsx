import { cloudAuthSource } from "@t3tools/client-runtime/cloud-auth";
import type { ReactNode } from "react";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { getCloudAuth } from "./cloudAuth";

const cloudAuth = getCloudAuth();

if (cloudAuth) {
  cloudAccountService.attach(cloudAuthSource(cloudAuth));
} else {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  return props.children;
}

import { getConnectName } from "../appName.ts";

export const NETWORK_BLOCKING_HINT_PARTS = [
  "Your DNS or firewall may be blocking ",
  ". Try another network, such as a different Wi-Fi or mobile data.",
] as const;

export const networkBlockingHint = () => NETWORK_BLOCKING_HINT_PARTS.join(getConnectName());

/** For a host that stopped answering on an open connection, so the network path was already working. */
export const UNRESPONSIVE_HOST_HINT = "It may be overloaded, asleep, or off the network.";

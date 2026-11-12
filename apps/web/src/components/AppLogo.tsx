import { cn } from "~/lib/utils";

import { useAppMonogram, useAppOwnerLogo } from "../state/appBranding";
import { ProjectMonogram } from "./ProjectMonogram";

export function OwnerLogo({
  logo,
  monogram,
  className,
}: {
  readonly logo: string | null;
  readonly monogram: string;
  readonly className?: string | undefined;
}) {
  return logo === null ? (
    <ProjectMonogram text={monogram} color="gray" className={className} />
  ) : (
    <img
      alt=""
      aria-hidden="true"
      src={logo}
      className={cn("size-4 shrink-0 rounded-[25%] object-cover", className)}
    />
  );
}

export function AppLogo({ className }: { readonly className?: string | undefined }) {
  return <OwnerLogo logo={useAppOwnerLogo()} monogram={useAppMonogram()} className={className} />;
}

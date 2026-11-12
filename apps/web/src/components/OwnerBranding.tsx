import { OWNER_NAME_MAX_LENGTH, resolveAppMonogram } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { readOwnerLogo } from "../lib/ownerLogo";
import { OwnerLogo } from "./AppLogo";
import { Button } from "./ui/button";
import { DraftInput } from "./ui/draft-input";

export function OwnerNameInput({
  value,
  onCommit,
  className,
}: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly className?: string | undefined;
}) {
  return (
    <DraftInput
      size="sm"
      className={className}
      value={value}
      onCommit={(next) => onCommit(next.trim())}
      maxLength={OWNER_NAME_MAX_LENGTH}
      placeholder="Your name"
      aria-label="Your name"
    />
  );
}

export function OwnerLogoPicker({
  logo,
  ownerName,
  onChange,
}: {
  readonly logo: string | null;
  readonly ownerName: string;
  readonly onChange: (next: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [unreadable, setUnreadable] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <OwnerLogo logo={logo} monogram={resolveAppMonogram(ownerName)} className="size-8" />
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file === undefined) return;
            void readOwnerLogo(file).then((next) => {
              setUnreadable(next === null);
              if (next !== null) onChange(next);
            });
          }}
        />
        <Button variant="outline" size="compact" onClick={() => inputRef.current?.click()}>
          {logo === null ? "Choose picture" : "Change picture"}
        </Button>
        {logo === null ? null : (
          <Button variant="ghost-muted" size="compact" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      {unreadable ? (
        <p className="text-xs text-destructive">That file could not be read as a picture.</p>
      ) : null}
    </div>
  );
}

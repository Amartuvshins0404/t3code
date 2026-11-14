import { cva, type VariantProps } from "class-variance-authority";
import { useState } from "react";

import { cn } from "~/lib/utils";

const avatarVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold leading-none select-none",
  {
    defaultVariants: { size: "sm", shape: "circle" },
    variants: {
      size: {
        xs: "size-4 text-[0.5rem]",
        sm: "size-5 text-[0.5625rem]",
        md: "size-6 text-3xs",
        lg: "size-8 text-xs",
      },
      shape: {
        circle: "rounded-full",
        square: "rounded-[25%]",
      },
    },
  },
);

type AvatarVariantProps = VariantProps<typeof avatarVariants>;

const initialsSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstGrapheme(value: string): string {
  const first = initialsSegmenter.segment(value)[Symbol.iterator]().next();
  return first.done ? "" : first.value.segment;
}

export function avatarInitials(name: string): string {
  const words = name
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter((word) => word.length > 0);
  const initials =
    words.length > 1
      ? `${firstGrapheme(words[0]!)}${firstGrapheme(words.at(-1)!)}`
      : firstGrapheme(words[0] ?? "");
  return initials.toUpperCase() || "?";
}

export function avatarHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export interface AvatarProps extends AvatarVariantProps {
  readonly name: string;
  readonly src?: string | null | undefined;
  readonly seed?: string | undefined;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

export function Avatar({ name, src, seed, label, size, shape, className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = typeof src === "string" && src.length > 0 && failedSrc !== src;
  const hue = avatarHue(seed ?? name);
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <span
      {...a11y}
      data-slot="avatar"
      className={cn(avatarVariants({ size, shape }), className)}
      style={
        showImage
          ? undefined
          : { backgroundColor: `oklch(0.86 0.07 ${hue})`, color: `oklch(0.36 0.1 ${hue})` }
      }
    >
      {showImage ? (
        <img
          alt=""
          src={src}
          loading="lazy"
          className="size-full bg-muted object-cover"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        avatarInitials(name)
      )}
    </span>
  );
}

export interface AvatarStackPerson {
  readonly id: string;
  readonly name: string;
  readonly image?: string | null | undefined;
}

export function AvatarStack({
  people,
  max = 3,
  size,
  className,
}: {
  readonly people: ReadonlyArray<AvatarStackPerson>;
  readonly max?: number;
  readonly size?: AvatarVariantProps["size"];
  readonly className?: string | undefined;
}) {
  const shown = people.slice(0, max);
  const hidden = people.length - shown.length;
  return (
    <span
      role="img"
      aria-label={people.map((person) => person.name).join(", ")}
      className={cn("flex shrink-0 items-center -space-x-1.5", className)}
      data-slot="avatar-stack"
    >
      {shown.map((person) => (
        <Avatar
          key={person.id}
          name={person.name}
          src={person.image}
          seed={person.id}
          size={size}
          className="ring-2 ring-background"
        />
      ))}
      {hidden > 0 ? (
        <span
          className={cn(
            avatarVariants({ size, shape: "circle" }),
            "bg-muted font-medium text-muted-foreground ring-2 ring-background",
          )}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

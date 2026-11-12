import { Image } from "expo-image";

import { useAppBranding } from "../state/appBranding";
import { ProjectIconGlyphView } from "./ProjectFavicon";

export function AppLogo(props: { readonly size: number }) {
  const { logo, monogram } = useAppBranding();
  return logo === null ? (
    <ProjectIconGlyphView
      glyph={{ kind: "monogram", text: monogram, color: "gray" }}
      size={props.size}
    />
  ) : (
    <Image
      source={{ uri: logo }}
      accessibilityIgnoresInvertColors
      style={{ width: props.size, height: props.size, borderRadius: props.size * 0.25 }}
    />
  );
}

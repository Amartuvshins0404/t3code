// The upstream T3 Code icon, as GitHub shows the T3 Code app, whatever this build's owner logo.
import appIconUrl from "../../../../assets/upstream/t3-code-github-app-icon-180.png";

export function T3AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}

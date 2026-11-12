import {
  type CloudAuth,
  type CloudSignInMethod,
  isCloudAuthError,
} from "@t3tools/client-runtime/cloud-auth";
import { KeyRoundIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";

import {
  readCloudSignInPromptOpen,
  setCloudSignInPromptOpen as setPromptOpen,
  subscribeCloudSignInPrompt,
} from "../../cloud/cloudSignInPrompt";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

export function CloudSignInDialog({ auth }: { readonly auth: CloudAuth }) {
  const open = useSyncExternalStore(subscribeCloudSignInPrompt, readCloudSignInPromptOpen);
  const [pending, setPending] = useState<CloudSignInMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);

  const close = () => {
    attempt.current?.abort();
    attempt.current = null;
    setPending(null);
    setError(null);
    setPromptOpen(false);
  };

  const signIn = (method: CloudSignInMethod) => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setPending(method);
    setError(null);
    auth.signIn(method, { signal: controller.signal }).then(
      () => {
        if (attempt.current !== controller) return;
        attempt.current = null;
        setPending(null);
        setPromptOpen(false);
      },
      (cause: unknown) => {
        if (attempt.current !== controller) return;
        attempt.current = null;
        setPending(null);
        if (isCloudAuthError(cause) && cause.reason === "cancelled") return;
        setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
      },
    );
  };

  const where = isElectron ? "your browser" : "the sign-in window";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setPromptOpen(true) : close())}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to T3 Connect</DialogTitle>
          <DialogDescription>
            {pending
              ? `Finish signing in in ${where}.`
              : "Use your GitHub account or a passkey to reach your environments from anywhere."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Button disabled={pending !== null} onClick={() => signIn("github")}>
              {pending === "github" ? <Spinner /> : null}
              Continue with GitHub
            </Button>
            <Button variant="outline" disabled={pending !== null} onClick={() => signIn("passkey")}>
              {pending === "passkey" ? <Spinner /> : <KeyRoundIcon />}
              Use a passkey
            </Button>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        {pending ? (
          <DialogFooter>
            <Button variant="ghost" onClick={() => attempt.current?.abort()}>
              Cancel
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

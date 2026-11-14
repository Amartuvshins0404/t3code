import { assignableTeamRoles, teamSlugFromName } from "@t3tools/client-runtime/cloud-auth";
import type { TeamRole } from "@t3tools/contracts";
import { useState } from "react";

import { getCloudTeams, setActiveWorkspace, useCloudTeamsState } from "../../cloud/cloudTeams";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { closeTeamDialog, useTeamUiStore } from "./teamUiStore";
import { TEAM_ROLE_LABELS, teamErrorMessage } from "./teamPresentation";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function TeamDialogsHost() {
  const dialog = useTeamUiStore((state) => state.dialog);
  if (dialog?.kind === "create") return <CreateTeamDialog />;
  if (dialog?.kind === "invite") return <InviteTeamDialog teamId={dialog.teamId} />;
  return null;
}

function CreateTeamDialog() {
  const [name, setName] = useState("");
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = customSlug ?? teamSlugFromName(name);
  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && slug.length > 0 && !pending;

  const submit = async () => {
    const teams = getCloudTeams();
    if (!teams || !canSubmit) return;
    setPending(true);
    setError(null);
    const result = await teams.create({ name: trimmedName, slug }).then(
      (team) => ({ ok: true as const, team }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    setPending(false);
    if (!result.ok) {
      setError(teamErrorMessage(result.cause, "Could not create the team."));
      return;
    }
    setActiveWorkspace(result.team.id);
    closeTeamDialog();
    toastManager.add({ type: "success", title: `Created ${result.team.name}` });
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create team</DialogTitle>
          <DialogDescription>
            Share machines and threads with the people you invite. You can delete it later.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="create-team-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="create-team-name">Name</Label>
              <Input
                id="create-team-name"
                placeholder="Acme"
                value={name}
                maxLength={64}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="create-team-slug">Short name</Label>
              <Input
                id="create-team-slug"
                value={slug}
                maxLength={40}
                spellCheck={false}
                onChange={(event) =>
                  setCustomSlug(
                    event.target.value.toLowerCase().replace(/[^a-z0-9-]/gu, "-") || null,
                  )
                }
              />
              <p className="text-xs text-muted-foreground">
                Letters, numbers and dashes. It must be unique.
              </p>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={closeTeamDialog} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="create-team-form" disabled={!canSubmit}>
            {pending ? "Creating…" : "Create team"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function InviteTeamDialog({ teamId }: { readonly teamId: string }) {
  const state = useCloudTeamsState();
  const team = state.status === "signedOut" ? null : state.teams.find((t) => t.id === teamId);
  const roles = assignableTeamRoles(team?.role ?? "member");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedEmail = email.trim();
  const validEmail = EMAIL_PATTERN.test(trimmedEmail);

  const submit = async () => {
    const teams = getCloudTeams();
    if (!teams || !validEmail || pending) return;
    setPending(true);
    setError(null);
    const result = await teams.invite({ teamId, email: trimmedEmail, role }).then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    setPending(false);
    if (!result.ok) {
      setError(teamErrorMessage(result.cause, "Could not save the invite."));
      return;
    }
    closeTeamDialog();
    toastManager.add({
      type: "success",
      title: `Invited ${trimmedEmail}`,
      description: "They see it in their switcher after they sign in with that email.",
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : closeTeamDialog())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite to {team?.name ?? "team"}</DialogTitle>
          <DialogDescription>
            No email is sent. The person sees the invite in their own workspace switcher after they
            sign in with this email address.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="invite-team-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="invite-team-email">Email</Label>
              <Input
                id="invite-team-email"
                type="email"
                placeholder="name@example.com"
                value={email}
                autoFocus
                spellCheck={false}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-team-role">Role</Label>
              <Select
                value={role}
                onValueChange={(next) => {
                  if (next !== null) setRole(next);
                }}
              >
                <SelectTrigger id="invite-team-role" aria-label="Role">
                  <SelectValue>{(value: TeamRole) => TEAM_ROLE_LABELS[value]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {roles.map((option) => (
                    <SelectItem key={option} value={option}>
                      {TEAM_ROLE_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={closeTeamDialog} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="invite-team-form" disabled={!validEmail || pending}>
            {pending ? "Inviting…" : "Invite"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

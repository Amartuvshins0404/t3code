import type {
  CloudTeamDetail,
  CloudTeamInvite,
  CloudTeamsState,
  CloudTeamSummary,
} from "@t3tools/client-runtime/cloud-auth";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { CloudAuthSnapshot } from "../../cloud/cloudAuth";
import type { TeamDetailState } from "../../cloud/cloudTeams";
import { useUiStateStore } from "../../uiStateStore";
import { TeamSettingsPanel } from "../settings/TeamSettings";
import { SidebarProvider } from "../ui/sidebar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

import "~/index.css";

const state = vi.hoisted(() => ({
  auth: null as unknown as CloudAuthSnapshot,
  teams: null as unknown as CloudTeamsState,
  detail: { status: "loading" } as TeamDetailState,
  accept: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock(import("../../cloud/cloudAuth"), async (original) => ({
  ...(await original()),
  getCloudAuth: (() => ({})) as never,
  useCloudAuth: () => state.auth,
}));
vi.mock(import("../../cloud/cloudTeams"), async (original) => {
  const actual = await original();
  const { useUiStateStore: useStore } = await import("../../uiStateStore");
  return {
    ...actual,
    useCloudTeamsState: () => state.teams,
    useActiveWorkspace: () =>
      actual.resolveActiveWorkspace(
        useStore((store) => store.activeWorkspace),
        state.teams,
      ).workspace,
    useTeamDetail: () => state.detail,
    refreshCloudTeams: () => {},
    getCloudTeams: (() => ({ accept: state.accept, reject: vi.fn() })) as never,
  };
});
vi.mock(import("../settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsSection: (({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  )) as never,
  SettingsRow: (({ title, description, control }: Record<string, ReactNode>) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
    </div>
  )) as never,
}));

const me = { id: "u-me", email: "me@example.com", name: "Me Person", image: null };
const acme: CloudTeamSummary = {
  id: "org-acme",
  name: "Acme",
  slug: "acme",
  logo: null,
  role: "admin",
};
const beta: CloudTeamSummary = {
  id: "org-beta",
  name: "Beta",
  slug: "beta",
  logo: null,
  role: "member",
};
const invite: CloudTeamInvite = {
  id: "inv-1",
  email: me.email,
  role: "member",
  teamId: "org-gamma",
  teamName: "Gamma",
};

function setup(input: {
  readonly signedIn: boolean;
  readonly teams?: ReadonlyArray<CloudTeamSummary>;
  readonly invites?: ReadonlyArray<CloudTeamInvite>;
  readonly active?: string;
  readonly detail?: CloudTeamDetail;
}) {
  state.auth = input.signedIn
    ? { isLoaded: true, isSignedIn: true, userId: me.id, user: me }
    : { isLoaded: true, isSignedIn: false, userId: null, user: null };
  state.teams = input.signedIn
    ? {
        status: "ready",
        userId: me.id,
        teams: input.teams ?? [],
        invites: input.invites ?? [],
        fresh: true,
      }
    : { status: "signedOut" };
  state.detail = input.detail ? { status: "ready", detail: input.detail } : { status: "loading" };
  state.accept.mockReset();
  state.accept.mockImplementation(async (invitationId) => {
    const accepted = state.teams.status === "signedOut" ? undefined : state.teams.invites;
    const joined = accepted?.find((candidate) => candidate.id === invitationId);
    if (joined && state.teams.status !== "signedOut") {
      state.teams = {
        ...state.teams,
        status: "loading",
        teams: [
          ...state.teams.teams,
          {
            id: joined.teamId,
            name: joined.teamName ?? "",
            slug: "",
            logo: null,
            role: joined.role,
          },
        ],
        invites: [],
      };
    }
  });
  useUiStateStore.setState({ activeWorkspace: input.active ?? "personal" });
}

function switcher() {
  return (
    <SidebarProvider>
      <WorkspaceSwitcher className="" fallback={null} />
    </SidebarProvider>
  );
}

describe("WorkspaceSwitcher", () => {
  it("lists teams and invites, and accepting an invite joins and switches to it", async () => {
    setup({ signedIn: true, teams: [acme, beta], invites: [invite], active: beta.id });
    await using screen = await render(switcher());
    await expect.element(screen.getByTestId("workspace-invite-dot")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Switch workspace, current: Beta/u }));
    await expect.element(page.getByRole("menuitemradio", { name: /Acme/u })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Team settings" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: /Invite people/u }).query()).toBeNull();

    await userEvent.click(page.getByRole("menuitem", { name: "Accept" }));
    await vi.waitFor(() => expect(state.accept).toHaveBeenCalledWith(invite.id));
    await vi.waitFor(() => expect(useUiStateStore.getState().activeWorkspace).toBe(invite.teamId));
  });

  it("offers sign-in and no team actions when signed out", async () => {
    setup({ signedIn: false });
    await using screen = await render(switcher());
    await userEvent.click(screen.getByRole("button", { name: /Switch workspace/u }));
    await expect
      .element(page.getByRole("menuitem", { name: "Sign in to use teams" }))
      .toBeVisible();
    expect(page.getByRole("menuitem", { name: /Create team/u }).query()).toBeNull();
  });

  it("falls back to Personal when the saved team is gone from a fresh list", async () => {
    setup({ signedIn: true, teams: [acme], active: "org-removed" });
    await using _screen = await render(switcher());
    await vi.waitFor(() => expect(useUiStateStore.getState().activeWorkspace).toBe("personal"));
  });
});

describe("TeamSettingsPanel", () => {
  const detail = (team: CloudTeamSummary): CloudTeamDetail => ({
    ...team,
    members: [
      {
        memberId: "m-owner",
        userId: "u-owner",
        name: "Olive Owner",
        email: "o@example.com",
        image: null,
        role: "owner",
      },
      {
        memberId: "m-other",
        userId: "u-other",
        name: "Max Member",
        email: "m@example.com",
        image: null,
        role: "member",
      },
      {
        memberId: "m-me",
        userId: me.id,
        name: me.name,
        email: me.email,
        image: null,
        role: team.role,
      },
    ],
    invites: [
      {
        id: "inv-9",
        email: "new@example.com",
        role: "member",
        teamId: team.id,
        teamName: team.name,
      },
    ],
  });

  it("shows a plain member no way to manage people or invites", async () => {
    setup({ signedIn: true, teams: [beta], active: beta.id, detail: detail(beta) });
    await using screen = await render(<TeamSettingsPanel />);
    await expect.element(screen.getByText("Max Member")).toBeVisible();
    expect(screen.getByRole("combobox").query()).toBeNull();
    expect(screen.getByRole("button", { name: /^Remove/u }).query()).toBeNull();
    expect(screen.getByRole("region", { name: "Invites" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Invite people" }).query()).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Leave team" })).toBeEnabled();
  });

  it("lets an admin manage members but not the owner", async () => {
    setup({ signedIn: true, teams: [acme], active: acme.id, detail: detail(acme) });
    await using screen = await render(<TeamSettingsPanel />);
    await expect.element(screen.getByRole("button", { name: "Remove Max Member" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Olive Owner" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: /^Remove Me Person/u }).query()).toBeNull();
    await expect.element(screen.getByText("new@example.com")).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete team" }).query()).toBeNull();
  });
});

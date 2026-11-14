import { describe, expect, it } from "@effect/vitest";

import { toTeamMembers } from "./TeamMembership.ts";

const row = {
  userId: "user-1",
  name: "Ada",
  email: "ada@example.test",
  image: null,
  organizationId: "org-1",
  organizationSlug: "team-one",
};

describe("toTeamMembers", () => {
  it("keeps the highest Better Auth role and never invents one", () => {
    expect(
      ["member", "admin", "owner", "member,admin", "admin, owner", "billing", "admin-ish"].map(
        (role) => toTeamMembers([{ ...row, role }])[0]?.role,
      ),
    ).toEqual(["member", "admin", "owner", "admin", "owner", "member", "member"]);
  });

  it("merges duplicate rows for one person into their highest role", () => {
    expect(
      toTeamMembers([
        { ...row, role: "member" },
        { ...row, role: "admin" },
        { ...row, name: " ", email: null, userId: "user-2", role: "member" },
      ]),
    ).toEqual([
      {
        userId: "user-1",
        name: "Ada",
        email: "ada@example.test",
        organizationId: "org-1",
        organizationSlug: "team-one",
        role: "admin",
      },
      {
        userId: "user-2",
        name: "user-2",
        organizationId: "org-1",
        organizationSlug: "team-one",
        role: "member",
      },
    ]);
  });
});

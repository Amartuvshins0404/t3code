import { EnvironmentId, ProjectId, type ProjectPlantStatus } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { projectEnvironment } from "../../state/projects";

export function projectPlantStatusesKey(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
): string {
  return projects.map((project) => `${project.environmentId}\t${project.id}`).join("\n");
}

export const projectPlantStatusesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const statuses = new Map<string, ProjectPlantStatus>();
    for (const line of key.split("\n")) {
      const [rawEnvironmentId, rawProjectId] = line.split("\t");
      if (!rawEnvironmentId || !rawProjectId) continue;
      const environmentId = EnvironmentId.make(rawEnvironmentId);
      const projectId = ProjectId.make(rawProjectId);
      if (!get(projectEnvironment.plant.permissionAtom(environmentId))) continue;
      const status = AsyncResult.getOrElse(
        get(projectEnvironment.readPlant({ environmentId, input: { projectId } })),
        () => null,
      );
      if (status !== null) statuses.set(`${environmentId}:${projectId}`, status);
    }
    return statuses;
  }),
);

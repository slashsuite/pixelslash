import { Caption, type Crumb } from "@slashsuite/ui-react";
import type { ReactNode } from "react";
import { hrefTo } from "#/lib/href";

/** The crumbs the review pages share, so each page lists only the ones above it. */
export function orgCrumb(org: { id: string; name: string }): Crumb {
  return { label: org.name, href: "/orgs" };
}

export function projectCrumb(project: { id: string; name: string }): Crumb {
  return {
    label: project.name,
    href: hrefTo("/projects/$projectId", { projectId: project.id }),
  };
}

/** The project's crumbs: a subproject's parent first, then the project itself. */
export function projectCrumbs(project: {
  id: string;
  name: string;
  parent: { id: string; name: string } | null;
}): Crumb[] {
  return [...(project.parent ? [projectCrumb(project.parent)] : []), projectCrumb(project)];
}

/** The build, by branch and short commit: the commit is a key, so it is set in mono. */
export function buildCrumbLabel(build: { branch: string; commitSha: string }): ReactNode {
  return (
    <>
      {build.branch}{" "}
      <Caption as="span" mono>
        {build.commitSha.slice(0, 7)}
      </Caption>
    </>
  );
}

export function buildCrumb(
  projectId: string,
  build: { id: string; branch: string; commitSha: string },
): Crumb {
  return {
    label: buildCrumbLabel(build),
    href: hrefTo("/projects/$projectId/builds/$buildId", { projectId, buildId: build.id }),
  };
}

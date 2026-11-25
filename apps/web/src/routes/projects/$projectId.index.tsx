import { createFileRoute } from "@tanstack/react-router";
import {
  Breadcrumbs,
  Button,
  Code,
  CopyLine,
  EmptyState,
  ListLayout,
  Step,
  Steps,
  TextLink,
  Text,
} from "@slashsuite/ui-react";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { SubprojectList } from "#/components/subprojects";
import { ProjectFlags } from "#/components/detection-flag";
import { BuildsList } from "#/components/builds-list";
import { StaleList } from "#/components/stale";
import { Page, useHydrated } from "#/components/ui";
import { getProjectPage } from "#/server/fns";
import { getSubprojects } from "#/server/subprojects";
import { hrefTo } from "#/lib/href";

export const Route = createFileRoute("/projects/$projectId/")({
  loader: async ({ params }) => {
    const data = { projectId: params.projectId };
    const [page, subprojects] = await Promise.all([
      getProjectPage({ data }),
      getSubprojects({ data }),
    ]);
    return { ...page, subprojects };
  },
  component: ProjectPage,
});

function ProjectPage() {
  const { project, org, builds, flags, stale, now, serverUrl, subprojects } = Route.useLoaderData();
  const parentCrumbs = project.parent ? [projectCrumb(project.parent)] : [];
  const newestSha = newestCommitOf(builds, subprojects);
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs items={[orgCrumb(org), ...parentCrumbs, project.name]} />}
        title={project.name}
        description={
          builds.length === 0
            ? "No builds yet."
            : `Builds newest first. ${builds.length} in this project.`
        }
        actions={
          <>
            {newestSha && (
              <Button
                data-testid="commit-review-link"
                href={hrefTo("/projects/$projectId/commits/$sha", {
                  projectId: project.id,
                  sha: newestSha,
                })}
              >
                Review commit {newestSha.slice(0, 7)}
              </Button>
            )}
            <Button
              variant="outline"
              href={hrefTo("/projects/$projectId/flakes", { projectId: project.id })}
            >
              Flakes
            </Button>
            <Button
              variant="outline"
              href={hrefTo("/projects/$projectId/settings", { projectId: project.id })}
            >
              Settings
            </Button>
          </>
        }
      >
        <SubprojectList subprojects={subprojects} defaultBranch={project.defaultBranch} />
        {builds.length === 0 ? (
          <EmptyProject project={project} serverUrl={serverUrl} />
        ) : (
          <BuildsList
            projectId={project.id}
            defaultBranch={project.defaultBranch}
            builds={builds}
            now={now}
          />
        )}
        <StaleList items={stale} />
        <ProjectFlags projectId={project.id} flags={flags} />
      </ListLayout>
    </Page>
  );
}

/**
 * The commit of the newest build in the project or any of its subprojects, whose combined review
 * the page links; null for a project without subprojects, which has its build page for that.
 */
function newestCommitOf(
  builds: { commitSha: string; createdAt: Date }[],
  subprojects: { latest: { commitSha: string; createdAt: Date } | null }[],
): string | null {
  if (subprojects.length === 0) return null;
  const all = [...builds.slice(0, 1), ...subprojects.flatMap((s) => (s.latest ? [s.latest] : []))];
  const newest = all.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return newest?.commitSha ?? null;
}

/**
 * A project with no builds: where the token comes from and the exact command that uploads. A
 * subproject's token is its parent's, so the link goes there and the command names the subproject.
 */
function EmptyProject({
  project,
  serverUrl,
}: {
  project: { id: string; name: string; parent: { id: string; name: string } | null };
  serverUrl: string;
}) {
  const hydrated = useHydrated();
  const flag = project.parent ? ` --subproject ${project.name}` : "";
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}${flag}`;
  const tokenOwner = project.parent ?? project;
  return (
    <EmptyState data-testid="empty-project" title="No builds yet">
      <Text tone="muted">
        A build is one upload of snapshots from CI or your machine. Builds on <Code>main</Code> are
        accepted as they land; a branch's builds are compared against them.
      </Text>
      <Steps>
        <Step
          title={
            <>
              Issue a CI token in{" "}
              <TextLink
                href={hrefTo("/projects/$projectId/settings", { projectId: tokenOwner.id })}
              >
                {project.parent ? `${project.parent.name}'s settings` : "Settings"}
              </TextLink>
              .
            </>
          }
        />
        <Step title="Upload a snapshot dir with it:">
          <CopyLine
            label="upload command"
            text={command}
            disabled={!hydrated}
            data-testid="upload-command"
          />
        </Step>
      </Steps>
    </EmptyState>
  );
}

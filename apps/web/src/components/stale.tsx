import {
  Caption,
  Card,
  Cluster,
  ListRow,
  Pill,
  Section,
  Stack,
  Text,
  TextLink,
} from "@slashsuite/ui-react";
import { type StaleItem, staleParts } from "#/lib/stale";
import { hrefTo } from "#/lib/href";

/** The marker on a twin whose web side changed since a reviewer last accepted it (PS-297). */
export function StaleBadge() {
  return (
    <Pill tone="warn" data-testid="stale-badge">
      Stale
    </Pill>
  );
}

/**
 * The project page's Stale list (PS-297): one sentence per stale native twin, with the build that
 * changed the web shot as a link, and a link to the native shot a reviewer accepts. Nothing when no
 * twin is stale, so a web-only project's page is the one it always was.
 */
export function StaleList({ items }: { items: StaleItem[] }) {
  if (items.length === 0) return null;
  return (
    <Section
      title={
        <>
          Stale{" "}
          <Text as="span" tone="muted">
            {items.length}
          </Text>
        </>
      }
    >
      <Card flush>
        <Stack divided>
          {items.map((item) => {
            const { before, after } = staleParts(item);
            const shot = item.shots[0];
            return (
              <ListRow
                key={`${item.platform}:${item.name}:${item.theme}`}
                data-testid="stale-item"
                leading={<StaleBadge />}
              >
                <Cluster gap="xs" align="baseline">
                  <Text as="span">
                    {before}
                    <TextLink
                      data-testid="stale-cause"
                      href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
                        projectId: item.cause.projectId,
                        buildId: item.cause.buildId,
                        snapshotId: item.cause.snapshotId,
                      })}
                    >
                      {item.cause.buildId.slice(0, 8)}
                    </TextLink>
                    {after}
                  </Text>
                  {shot && (
                    <TextLink
                      size="sm"
                      data-testid="stale-shot"
                      href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
                        projectId: shot.projectId,
                        buildId: shot.buildId,
                        snapshotId: shot.snapshotId,
                      })}
                    >
                      Review the {item.platform} shot
                    </TextLink>
                  )}
                </Cluster>
                {item.shots.length > 1 && (
                  <Caption as="span" tone="muted">
                    {item.shots.length} devices and sizes
                  </Caption>
                )}
              </ListRow>
            );
          })}
        </Stack>
      </Card>
    </Section>
  );
}

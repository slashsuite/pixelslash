import { Avatar, Button, ListRow, Overline, Pill, Stack } from "@slashsuite/ui-react";
import type { OrgOverview } from "#/db/orgs";
import { hrefTo } from "#/lib/href";

/**
 * The organizations down the left, each with how many of its projects have a latest build waiting
 * on a decision: an amber "N to review" badge when there is work, and nothing when there is not.
 * With no organization yet the page's empty state holds the one "New organization" button.
 */
export function OrgRail({
  orgs,
  selectedId,
  onNew,
  hydrated,
}: {
  orgs: OrgOverview[];
  selectedId: string | null;
  onNew: () => void;
  hydrated: boolean;
}) {
  return (
    <Stack gap="sm">
      <Overline as="h2">Organizations</Overline>
      <nav aria-label="Organizations">
        <Stack gap="xs">
          {orgs.map((org) => (
            <ListRow
              key={org.id}
              size="sm"
              selected={org.id === selectedId}
              leading={<Avatar name={org.name} size="sm" shape="square" />}
              trailing={
                org.waiting > 0 && (
                  <Pill
                    tone="warn"
                    round
                    data-testid="org-waiting"
                    title={`${org.waiting} ${org.waiting === 1 ? "project has" : "projects have"} shots to review`}
                  >
                    {org.waiting} to review
                  </Pill>
                )
              }
              href={hrefTo("/orgs", {}, { search: { org: org.id } })}
            >
              {org.name}
            </ListRow>
          ))}
        </Stack>
      </nav>
      {orgs.length > 0 && (
        <Button variant="dashed" disabled={!hydrated} onClick={onNew}>
          New organization
        </Button>
      )}
    </Stack>
  );
}

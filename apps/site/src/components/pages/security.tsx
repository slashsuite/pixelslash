import { Callout, ProseLayout, TextLink } from "@slashsuite/ui-react";
import type { ReactNode } from "react";
import { SECURITY_DOC } from "../../content/repo-docs.ts";
import { CONTACT, REPO_PUBLIC } from "../../content/links.ts";
import { DocBody } from "../../content/markdown.tsx";

/** SECURITY.md, rendered at build time. */
export function SecurityPage(): ReactNode {
  return (
    <ProseLayout
      title="Security"
      description="SECURITY.md from the repository, as it is at this commit."
      gap="lg"
    >
      {REPO_PUBLIC ? null : (
        <Callout tone="info" title="Until the repository opens" data-testid="repo-closed">
          GitHub's private reporting needs the repository to be public, and it is not yet. Until it
          is, email <TextLink href={`mailto:${CONTACT}`}>{CONTACT}</TextLink>.
        </Callout>
      )}
      <DocBody doc={SECURITY_DOC} />
    </ProseLayout>
  );
}

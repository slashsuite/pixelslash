import {
  Caption,
  Callout,
  Card,
  Overline,
  ScrollStrip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
} from "@slashsuite/ui-react";
import { StaleBadge } from "#/components/stale";
import {
  NOT_MEASURED,
  type ParityMetricsView,
  type ParityPairView,
  type ParityShotColumn,
  type ParityView,
  pairLabel,
  scaleText,
} from "#/lib/parity-view";
import { staleDate } from "#/lib/stale";
import { twinSourceLabel } from "#/lib/twins";
import { hrefTo } from "#/lib/href";

/**
 * The parity view of one shot key (PS-298): web, android and ios side by side at one physical
 * size, the metrics comparison under them, and a similarity hint per native column. The hint is
 * shown and nothing else: it is no status, check or count.
 */

function ShotLink({ column }: { column: ParityShotColumn }) {
  return (
    <TextLink
      data-testid="parity-shot-link"
      href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
        projectId: column.projectId,
        buildId: column.buildId,
        snapshotId: column.snapshotId,
      })}
    >
      {column.label}
    </TextLink>
  );
}

/** A shot is drawn at its physical size: its pixels divided by its scale. */
function ShotColumn({ column }: { column: ParityShotColumn }) {
  const { physical } = column;
  return (
    <Stack gap="xs" data-testid="parity-column" data-platform={column.platform}>
      <Overline as="h3" tone="muted">
        {column.platform}
      </Overline>
      <Text strong>
        <ShotLink column={column} />
        {column.stale && (
          <>
            {" "}
            <StaleBadge />
          </>
        )}
      </Text>
      <Caption tone="muted" data-testid="parity-meta">
        {column.viewport} · scale {scaleText(column.scale)} · {twinSourceLabel(column.source)} ·{" "}
        {column.projectName}
      </Caption>
      {column.stale && (
        <Caption tone="muted" data-testid="parity-stale-cause">
          web changed, accepted by {column.stale.acceptedBy ?? "someone"}{" "}
          {staleDate(column.stale.acceptedAt)}
        </Caption>
      )}
      <img
        src={column.imageUrl}
        alt={`${column.label} shot`}
        data-testid="parity-image"
        style={physical ? { width: physical.width, maxWidth: "none" } : undefined}
        className="block h-auto border border-current/25"
      />
      {physical && (
        <Caption tone="muted" data-testid="parity-physical">
          {physical.width} × {physical.height} px at {scaleText(column.scale)}
        </Caption>
      )}
      {column.similarity && (
        <Caption tone="muted" data-testid="parity-similarity">
          {column.similarity.text}
        </Caption>
      )}
      {!column.hasMetrics && <Caption tone="muted">{NOT_MEASURED}</Caption>}
    </Stack>
  );
}

function Columns({ columns }: { columns: ParityView["columns"] }) {
  return (
    <ScrollStrip label="Shots by platform" gap="md" data-testid="parity-columns">
      {columns.map((c) =>
        c.kind === "missing" ? (
          <Stack
            gap="xs"
            key={`missing:${c.platform}`}
            data-testid="parity-missing"
            data-platform={c.platform}
          >
            <Overline as="h3" tone="muted">
              {c.platform}
            </Overline>
            <Text tone="muted">{`no ${c.platform} twin`}</Text>
            <Caption tone="muted">{c.line}</Caption>
          </Stack>
        ) : (
          <ShotColumn key={c.snapshotId} column={c} />
        ),
      )}
    </ScrollStrip>
  );
}

function Pair({ pair }: { pair: ParityPairView }) {
  return (
    <li data-testid="parity-pair" data-status={pair.status}>
      <Stack gap="xs">
        <Text strong>{pairLabel(pair)}</Text>
        {pair.status === "not_measured" && (
          <Text tone="muted">
            {`${NOT_MEASURED}: no metrics file on ${pair.lacks.join(" or ")}`}
          </Text>
        )}
        {pair.status === "clean" && <Text tone="muted">no mismatch</Text>}
        {pair.mismatches.map((m) => (
          <Text key={m} data-testid="parity-mismatch">
            {m}
          </Text>
        ))}
        {pair.declared.length > 0 && (
          <Stack gap="xs" data-testid="parity-declared">
            <Caption tone="muted">Declared differences (not mismatches)</Caption>
            {pair.declared.map((d) => (
              <Text tone="muted" key={d}>
                {d}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </li>
  );
}

function RawNumbers({ metrics }: { metrics: ParityMetricsView }) {
  if (metrics.raw.length === 0) return null;
  const caption = "The numbers each shot measured";
  return (
    <Stack gap="xs">
      <Caption tone="muted">{caption}</Caption>
      <Table label={caption} data-testid="parity-raw">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Part</TableHeaderCell>
            <TableHeaderCell>Field</TableHeaderCell>
            {metrics.rawColumns.map((c) => (
              <TableHeaderCell key={c.snapshotId}>
                {c.label}
                {!c.measured && <> ({NOT_MEASURED})</>}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {metrics.raw.map((r) => (
            <TableRow key={`${r.part}:${r.field}`}>
              <TableCell>{r.part}</TableCell>
              <TableCell>{r.field}</TableCell>
              {r.values.map((v, i) => (
                <TableCell key={metrics.rawColumns[i]?.snapshotId ?? i} mono>
                  {v ?? "n/a"}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  );
}

function MetricsSection({ metrics }: { metrics: ParityMetricsView }) {
  return (
    <Stack as="section" gap="sm" data-testid="parity-metrics">
      <Overline as="h2" tone="muted">
        Metrics
      </Overline>
      {metrics.notice && (
        <Callout tone="info" data-testid="parity-manifest-notice">
          {metrics.notice}
        </Callout>
      )}
      {metrics.pairs.length === 0 ? (
        <Text tone="muted">Only one platform has a shot here: nothing to compare.</Text>
      ) : (
        <Stack as="ul" gap="sm">
          {metrics.pairs.map((p) => (
            <Pair key={`${p.a.snapshotId}:${p.b.snapshotId}`} pair={p} />
          ))}
        </Stack>
      )}
      <RawNumbers metrics={metrics} />
    </Stack>
  );
}

export function ParityBody({ view }: { view: ParityView }) {
  return (
    <Stack gap="lg" data-testid="parity">
      <Card>
        <Columns columns={view.columns} />
      </Card>
      <MetricsSection metrics={view.metrics} />
    </Stack>
  );
}

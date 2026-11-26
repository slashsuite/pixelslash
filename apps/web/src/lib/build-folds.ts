/** The fields a build in the project's list is folded by. */
type FoldableBuild = {
  id: string;
  branch: string;
  status: string;
  counts: { toReview: number };
};

/** One line of the builds list: a build, or the run of quiet builds folded behind it. */
export type ListItem<B> = { kind: "build"; build: B } | { kind: "fold"; key: string; builds: B[] };

/** A build the list can fold: on the default branch, passed and with nothing to review, so auto-accepted. */
const isQuiet = (build: FoldableBuild, defaultBranch: string) =>
  build.branch === defaultBranch && build.status === "passed" && build.counts.toReview === 0;

/**
 * The builds list with each run of quiet builds (two or more auto-accepted builds of the default
 * branch, back to back) cut to its newest: the rest of the run is one fold the reader can open.
 * A build that waits on someone, or one on another branch, is never folded.
 */
export function foldQuiet<B extends FoldableBuild>(
  builds: B[],
  defaultBranch: string,
): ListItem<B>[] {
  const items: ListItem<B>[] = [];
  let run: B[] = [];
  const flush = () => {
    const [newest, ...rest] = run;
    if (newest) items.push({ kind: "build", build: newest });
    // Keyed by the run's oldest build, which a newer quiet build arriving on top does not change.
    const oldest = rest.at(-1);
    if (oldest) items.push({ kind: "fold", key: oldest.id, builds: rest });
    run = [];
  };
  for (const build of builds) {
    if (isQuiet(build, defaultBranch)) {
      run.push(build);
      continue;
    }
    flush();
    items.push({ kind: "build", build });
  }
  flush();
  return items;
}

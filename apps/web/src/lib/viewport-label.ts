/**
 * A shot's viewport as a reader names it: "Phone 390x844", "Desktop 1280x800". A capture that
 * shoots each story at two widths gives both shots one name, so the list must say which is which,
 * and a bare `390x844` beside the theme and the browser was easy to miss. The size stays in the
 * label, so two viewports of one class still differ. A value that is not `<width>x<height>` is
 * shown as it came.
 */
export function viewportLabel(viewport: string): string {
  const match = /^(\d+)x(\d+)$/.exec(viewport);
  if (!match) return viewport;
  return `${kindOf(Number(match[1]))} ${viewport}`;
}

/** The usual breakpoints: under 600 is a phone, under 1024 a tablet, the rest a desktop. */
function kindOf(width: number): string {
  if (width < 600) return "Phone";
  if (width < 1024) return "Tablet";
  return "Desktop";
}

import { Button, ButtonGroup } from "@slashsuite/ui-react";

/** The flag form's buttons: save (once a kind is picked), withdraw your own, cancel. */
export function FlagFormActions({
  picked,
  mine,
  busy,
  onWithdraw,
  onCancel,
}: {
  picked: boolean;
  mine: boolean;
  busy: boolean;
  onWithdraw: () => void;
  onCancel: () => void;
}) {
  return (
    <ButtonGroup>
      <Button
        type="submit"
        disabledReason={picked ? undefined : "Pick missed change or false positive"}
        busy={busy && "Saving…"}
      >
        {mine ? "Save flag" : "Flag"}
      </Button>
      {mine && (
        <Button type="button" variant="outline" disabled={busy} onClick={onWithdraw}>
          Withdraw
        </Button>
      )}
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </ButtonGroup>
  );
}

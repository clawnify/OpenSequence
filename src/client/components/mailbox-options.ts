import type { MailboxOption } from "@/types";
import type { PickerOption } from "@/components/ui/picker";

// The mailboxes a person can pick to send from, for Settings and a campaign.

/** Whose a mailbox is, in a few words. */
export function whose(m: MailboxOption): string {
  if (!m.personal) return m.isDefault ? "The team's main Gmail" : "The team's";
  return m.mine ? "Yours, only you use it" : "A teammate's own";
}

/**
 * The mailboxes the person may send from, and the one picked if it isn't one
 * of them, so the field never looks empty: a teammate's own mailbox an admin
 * picked, or one no longer connected.
 */
export function mailboxOptions(boxes: MailboxOption[], current: string | null): PickerOption[] {
  const options = boxes.filter((m) => m.can_use).map((m) => ({ value: m.address, label: m.address, hint: whose(m) }));
  if (current && !options.some((o) => o.value === current)) {
    const known = boxes.find((m) => m.address === current);
    options.push({ value: current, label: current, hint: known ? `${whose(known)}: only they, an owner or an admin can pick it` : "Not connected any more" });
  }
  return options;
}

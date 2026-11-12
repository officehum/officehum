/**
 * The desk a role's tools work through: the host's system of record, or the role's demonstration one.
 */

/**
 * The desk, or a refusal: a host that bound no desk gets no read and no write. `what` names the
 * desk in the message, e.g. `"sales"` or `"accounts"`.
 */
export function requireDesk<Desk>(desk: Desk | undefined, what: string): Desk {
  if (desk === undefined) {
    throw new Error(
      `No ${what} desk is bound to this role, so nothing was read or written. The host passes its system of record as \`desk\`, or sets \`demo\` to run on the demonstration data.`,
    );
  }
  return desk;
}

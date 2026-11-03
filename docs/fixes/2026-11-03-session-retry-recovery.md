# User-directed recovery after a lost agent runtime

A connection restart can retain the previous runtime's active turn while its
native session has no terminal record. The old proof-only recovery then leaves
both the host and panel blocked indefinitely.

The frozen-session banner now offers **Retry recovery** for every provider.
Clicking it requests recovery of the original native session; it does not send a
prompt, replay the previous command, create a replacement session, or claim that
the previous task succeeded. Pending queued messages are cancelled, with their
content retained. The banner has one recovery action; native activity and identity
checks run behind that action, without a separate proof-only button.

The control plane binds the request to the account, session, execution segment,
content epoch, reservation and live connection. The host verifies the native
session's identity, working directory and idle state before atomically persisting
an interruption of the old pending state. The panel releases its reservation only
on the matching host acknowledgement. Active/unknown native activity, changed
bindings, unresolved command receipts and active voice sessions remain blocked.
Repeated clicks reuse the same operation. No recovery runs merely by opening the
page; the affected incident is intentionally left for the user to recover.

Agent **0.30.162** advertises `sessionRecoveryDismiss`. Older agents must upgrade;
a panel-only release cannot fix their retained local active-turn state. An old
agent whose upgrade is itself blocked by this stale state needs an operator to
install the new connection service on that host before the user clicks recovery.

Validation covers all seven provider IDs, stale request rejection, account
isolation, queue retention, duplicate requests, native activity and runtime races,
plus the UI's explicit-click and asynchronous acknowledgement behavior. The
recovery tests run on SQLite and isolated PostgreSQL test schemas. No native
prompt or production recovery is part of these tests.

# Manual continuation of a dispatched voice todo

A job records one execution attempt. Its failure is never rewritten when the user
finishes the same intent manually in the target session.

Schema 53 adds an independent, immutable completion resolution. An authenticated
owner may PATCH /api/voice-tasks/:id, or use the existing voice tool
`todo.update`, with `revision`, exact `sessionId`, `nativeTurnId` and
`confirmed: true`. Omit `state` and `intent`. Current Agent 0.30.89 already
supports these input fields; recovery responses describe this operation.

Only an already dispatched todo whose original job is terminal is eligible.
The server verifies same-session, current-content-epoch, retained native
`turn.completed` evidence (including completed status) and a complete final
assistant reply. No task is started or resumed. Missing, expired or deleted
evidence is rejected. It does not guess that another completed turn fulfilled
the intent: the user must explicitly confirm that relationship. Currently this
operation needs native events already synchronized to the server; native-only
history without synchronized evidence cannot be used to resolve a todo.

A transaction adds the resolution, increments the todo revision and writes an
audit with actor, original job state, exact event/turn identifiers and result
hash. Same-turn retries return the existing resolution; different evidence
cannot overwrite it. The original job, failed turn and error remain intact.
Dispatch retries with that todo still return the original job without issuing a
new command. Other users cannot access or change the record.

Record and todo-scoped status report effective `state: completed`, while the
nested job retains `failed`. Job-scoped status retains its execution state and
adds `todoState` and `resolution`. Recovery excludes resolved intents. The
all-records view shows manual completion and original execution separately.

Resolution content is read through its original payload reference, not copied.
Content expiry, deletion, sharing-policy changes and permission checks still
apply. These can hide the reply but do not undo the completion fact or audit.

Publish with packaging/deploy-control-plane.py after tests. Schema 53 requires
a compatible server binary; a rollback to schema-52 code requires the publisher's
predeployment database backup and the documented safe rollback procedure.

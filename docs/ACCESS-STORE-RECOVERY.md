# Access store failure and recovery

This change is limited to `.liyuan/access.json`. It does not change network binding, password policy, WebSocket revocation, CSRF policy, or program-card permissions.

## Behavior

- An absent access file still means that no access password is configured.
- An unreadable or invalid password file stops startup. It must not silently open the instance.
- Malformed token entries are discarded while valid password data remains protected. Sign in again if a token was discarded.
- Writes use an exclusive random temporary file in the same directory, mode `0600`, file flush, then rename. This avoids truncating the current file during normal replacement. It is not a guarantee against every filesystem or power-loss failure.
- Token issuance and revocation update in-memory state only after disk publication succeeds.
- Failure to remove a password file is reported, not treated as successful password removal.

## Recovery

Stop the service and restrict network access first. Keep the damaged file for diagnosis without sharing its contents. Restore `access.json` from a trusted backup, check file permissions, and restart. Do not delete the file as a generic recovery step: absence intentionally means open access. If resetting without a backup, keep the instance isolated until a new password is configured.

## Validation

Run `node --test test/access-store.test.ts` on the supported Node runtime, then run the repository test and build checks. The authored tests cover corrupted storage, password/token round-trip, FIFO retention, token filtering, failed publication and failed removal. This change was authored through the GitHub API without a local execution environment; test execution must be confirmed in CI before merge.

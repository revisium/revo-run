# Redaction and Artifacts v1

- Status: Stable contract; enforcement implementation is deferred.

Every provider payload crosses one redaction-and-bounds boundary before storage
or emission. Normal `safeProjection` permits fixed codes, bounded time/counter/
usage/pin/provider-invocation values, immutable typed artifact references, and a
sanitized UTF-8 summary of at most 4 KiB. It denies prompts, raw provider events,
environment, credentials, tokens, auth headers, source/diff blobs, arbitrary
filesystem paths, private user content, and stack traces.

Restricted diagnostics are optional ACL-protected redacted references outside
normal evidence APIs. They cannot route work. Inline artifacts are redacted and
capped at 64 KiB. Content-addressed artifacts require digest and bytes; external
artifacts require an immutable revision. Retention class is caller-owned;
retention operations are explicit. Deletion and compaction are outside Phase 1.

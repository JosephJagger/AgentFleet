# Panel image delivery without changing native interaction

## Scope

The earlier `a4b5132` release reduced browser history refetch storms, introduced incremental history, and made new panel WebSocket subscriptions notification-only. This change removes repeated image bytes from the panel history responses as well.

Only browser history and image presentation change. Native Agent sources, task dispatch, command hydration, image input validation, native conversation records, model context, approvals, and tool execution are unchanged. No image is resized or transcoded. No storage migration or native process restart is required.

## Behavior

- Updated panel history requests opt in with `images=links`, alongside `compact=1`. Stored event images become session/event/hash-scoped authenticated URLs. History queries check availability without selecting the Base64 image data. Older clients retain their existing response format.
- Native `CloudImages.hydrate()` is unchanged: task commands still receive their original data URLs. Display URLs are deliberately rejected as task image inputs.
- The new image endpoint verifies workspace, session, event owner, project content sharing, projection/content epoch, retention, and cleanup tombstones before serving bytes or a 304 response.
- Responses use `private, no-cache` and a content-based ETag. A cache hit avoids transferring image bytes (and selects only a small image header from the database). This intentionally requires revalidation rather than a long immutable cache lifetime, so deletion/access changes can be enforced on subsequent requests. It cannot erase a copy previously downloaded by a user.
- Generated-image lightboxes mount the large preview image only after opening and remove it on close. Original downloads retain the original raster bytes and MIME type.

## Validation

Control-plane build and web typecheck pass. 24 server tests and 40 web tests cover history/reconnection, original-image byte equality, native command payload equality, anonymous/foreign-session/foreign-workspace denial, owner/hash binding, retention/deletion/content-policy changes including conditional requests, cleanup, image input validation, and lazy lightbox mounting.

An isolated fixture containing a 500 KB generated image returns less than 1/100 of the previous uncompressed history response size; a subsequent image request with the matching ETag returns 304 and zero body bytes. This is a regression fixture, not a measurement of production bandwidth savings.

## Remaining boundaries

Large host-streamed originals retain their existing transfer/cache behavior; this release does not infer an immutable identity for mutable host files or introduce thumbnails. Old panel tabs and legacy extensions keep their old opt-in behavior until updated. Browser refresh is needed to load the new frontend, but the deployment never forces a refresh or resends tasks. Native image blocks still consume provider-specific vision tokens; browser image viewing does not call a model.

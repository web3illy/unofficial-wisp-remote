# Attachment contract

Wisp Remote prepares attachments on the phone and keeps draft bytes only in the
Mac companion's memory. The installed Wisp Runtime has no upload endpoint. A
completed draft is converted into the native content blocks in the same
`POST /api/sessions/:id/stream` request as the human message.

## Bridge operations

Both HTTP and encrypted companion RPC expose the same finite operations:

- `POST /bridge/attachments/begin`
  - body: `{sessionId, kind, filename, size, mimeType?, width?, height?}`
  - `sessionId` is required. `kind` is `file`, `pdf_text`, or `image`.
  - returns opaque `id` plus safe metadata.
- `POST /bridge/attachments/chunk`
  - body: `{id, offset, dataBase64}`
  - decoded chunks are sequential and at most 16 KiB. Base64 must be canonical.
- `POST /bridge/attachments/commit`
  - body: `{id}`
  - validates exact byte count and content before making the draft sendable.
- `POST /bridge/attachments/remove`
  - body: `{id}`
  - removes a draft owned by the caller.

`POST /bridge/sessions/:sessionId/messages` accepts `attachments: [id, ...]`.
Text is optional only when at least one attachment is present. Every ID must be
committed and bound to the authenticated peer and the same session.

HTTP uses the existing pinned local/Tailscale browser identity as one owner.
Encrypted RPC uses the paired iroh endpoint ID. Revocation drops that peer's
drafts. A peer cannot inspect, remove, resolve, or send another owner's draft.

## Bounds and validation

- At most 10 live drafts per owner.
- At most 5 MiB decoded bytes per attachment and 15 MiB reserved per owner.
- Draft lifetime is 15 minutes. Cleanup runs on attachment operations.
- Filenames are 1–255 characters and cannot contain control characters,
  slashes, backslashes, `.` or `..` path names.
- Text and extracted PDF content must be valid UTF-8. A NUL byte in the first
  8192 bytes is rejected as binary input.
- Images must be JPEG, at most 2048 × 2048, with valid JPEG framing and a SOF
  size that exactly matches the declared width and height.
- Request bodies remain under the existing 32 KiB HTTP and 64 KiB companion
  request limits; the 16 KiB decoded chunk size fits both encodings.

Declared byte totals are reserved at `begin`, so incomplete parallel drafts
cannot exceed the owner's memory quota. Drafts are never written to a phone
supplied path or executed as HTML.

## Phone preparation

The browser picker accepts UTF-8 text and images. Images are rasterized in a
canvas to JPEG quality 0.85 with a maximum dimension of 2048 before upload.
PDF selection is available only through the native iPhone picker, which
extracts text with PDFKit; there is no OCR fallback. The native picker responds
to `{kind: "pickFiles", sessionId}` with prepared files containing base64 bytes
and matching metadata.

## Native Wisp blocks

After validation, the bridge sends a content array containing an optional text
block followed by attachment blocks:

```text
{type: "text", text}
{type: "file", filename, content}
{type: "pdf_text", filename, content}
{type: "image_url", image_url: {url: "data:image/jpeg;base64,..."}, mimeType: "image/jpeg", width, height}
```

A draft is consumed only after Wisp accepts the stream request. If delivery is
unknown or rejected before acceptance, the committed draft remains available
for the exact same message ID. Idempotency records are scoped by owner, session,
and message ID, and an exact accepted retry does not need the consumed bytes.

Normalized chat history returns only attachment kind, filename, MIME type, and
dimensions when available. It does not return inline file/PDF text or image
data URLs to the phone. Image preview fetch is outside this slice.

# Feedback and bug reports

The feedback form on the comic home page and the report action in the studio use the same inbox. Guests can report a signup problem. Signed-in submissions use the verified account. The reporter may share a 4,000-character description, a rating, a category, the current app area and up to ten screenshots. Only the app area checkbox selects context. Draft text and images stay in the form until the reporter sends or dismisses it.

The form previews PNG, JPEG and WebP images locally. Each source image may be up to 10 MiB and 16 megapixels. The browser reduces the longest edge to at most 1,920 pixels and sends up to 512 KiB per image. The API independently decodes accepted raster formats, removes embedded metadata and re-encodes as static WebP. The saved limit is 384 KiB per image and 3.75 MiB per report. File names stay on the device.

## Sending and reviewing

The API assigns each saved report an ID. Retrying the same draft after a timeout returns the same ID. The report text, its receipt and every normalized image commit together. If the API cannot confirm storage, the form keeps the draft open and displays a retry action.

Staff with the admin role can review reports under **Admin → Analytics → Feedback**. Select **Bug reports** or **General reports**, then **View screenshots** to retrieve one attachment at a time. This endpoint verifies admin access and disables caching. The inbox metadata contains the attachment count. Attachments have no public URL.

## Storage and operations

Apply `server/sql/telemetry_feedback.sql` followed by `server/sql/member_feedback_reports.sql`. The API uses its existing server-side Supabase credentials. Service-role access is required to execute the submission function or read either new table. The original inbox remains the source of report text. The new tables inherit the database's backup and restore arrangements.

The API limits submissions to eight per minute per verified account or guest network. Multiple server replicas share this rate limiter when Redis is configured. The database atomically checks retained screenshot bytes and rolling 24-hour allowances of 10 MiB per guest network or 40 MiB per account. The quota index uses a keyed digest. Report rows do not store a guest IP. The default retained image capacity is 1 GiB. Set `FEEDBACK_IMAGE_STORAGE_LIMIT_BYTES=0` to pause new screenshot storage while allowing text reports. Already accepted reports and their screenshots remain available.

Deleting a report through an authorized data-removal process cascades to its receipt and images and frees their capacity. A release rollback can leave both tables in place to preserve accepted reports. Database backup retention also governs the lifetime of removed data in backups.

```sql
select count(*) as reports,
       count(*) filter (where image_bytes > 0) as reports_with_screenshots,
       coalesce(sum(image_bytes), 0) as stored_image_bytes
from public.feedback_report_receipts;
```

The database fixture in `server/sql/tests/member_feedback_reports.test.sql` covers transaction rollback, ten attachments, deduplication, quotas, cascades and role grants. The HTTP tests exercise image re-encoding and the admin read gate using synthetic data.

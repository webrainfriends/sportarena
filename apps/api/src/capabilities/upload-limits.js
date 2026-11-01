// One size limit for every document upload in the system. Anyone signed in may read it (the apps use it to fail early with a plain
// message); only the platform admin may change it, enforced here on the server. The upload routes read the same value (src/doc-store.js).
import { z } from 'zod';
import { cap } from '../registry.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { DOC_MB, documentLimitRow, documentMaxMb, setDocumentMaxMb } from '../platform-settings.js';

const TAG = 'Platform settings';
const shape = () => ({ document_max_mb: documentMaxMb(), min_mb: DOC_MB.min, max_mb: DOC_MB.max, default_mb: DOC_MB.default });

cap({
  name: 'get_upload_limits', method: 'GET', path: '/upload-limits', tag: TAG,
  summary: 'The largest size, in MB, of one uploaded document (PDF, photo, Word/Excel, evidence) anywhere in the system, plus the range the platform admin may set. Videos, voice notes and logos keep their own limits.',
  input: z.object({}),
  async handler() { return shape(); },
});

cap({
  name: 'set_upload_limits', method: 'PATCH', path: '/admin/upload-limits', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: set the largest size of one uploaded document for every upload field in the system (1 to 50 MB). Applies immediately; existing files are untouched.',
  input: z.object({ document_max_mb: z.number().int().min(DOC_MB.min).max(DOC_MB.max) }),
  async handler({ user }, input) {
    await mustBePlatformAdmin(user);
    await setDocumentMaxMb(input.document_max_mb, user.id);
    await audit(null, user.id, 'set_upload_limits', 'platform_settings', null);
    return { ...shape(), updated_at: (await documentLimitRow())?.updated_at };
  },
});

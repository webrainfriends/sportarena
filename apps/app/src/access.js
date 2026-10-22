// Plain-language messages for the three states a delegated role can hit: denied (403), gone (404, e.g. access revoked) and stale (409).
import React from 'react';
import { Empty, ErrorBox } from './ui';

/** Message for a failed call; the server's own wording is kept for denials, because it names the role and the action. */
export const explain = (e) => (e?.status === 409 ? `${e.message} — the latest version has been loaded; check it and try again.` : e?.status === 404 ? 'You no longer have access to this, or it no longer exists.' : '' + (e?.message ?? e));

/** Full-screen/section state for a failed load: revoked or denied access is not retryable, anything else is. */
export function LoadError({ error, onRetry }) {
  if (error?.status === 403 || error?.status === 404) return <Empty emoji="🔒" title="No access" sub={error.status === 403 ? error.message : 'Your access may have been removed, or this no longer exists. Ask a manager of the organisation if you think that is a mistake.'} />;
  return <ErrorBox error={error} onRetry={onRetry} />;
}

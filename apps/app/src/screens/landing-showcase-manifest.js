import { useEffect, useState } from 'react';
import { api } from '../api';

// Module-level cache so re-mounts don't re-fetch
let _manifest = null;
let _promise = null;

export function useManifest() {
  const [state, setState] = useState({ manifest: _manifest, loading: !_manifest, error: null });

  useEffect(() => {
    if (_manifest) return;
    if (_promise) {
      _promise.then((m) => setState({ manifest: m, loading: false, error: null }))
               .catch(() => setState({ manifest: null, loading: false, error: 'unavailable' }));
      return;
    }
    _promise = (async () => {
      const { cdn_manifest_url } = await api.get('/landing/manifest');
      const res = await fetch(cdn_manifest_url);
      if (!res.ok) throw new Error('manifest_fetch_failed');
      return res.json();
    })();
    _promise.then((m) => { _manifest = m; setState({ manifest: m, loading: false, error: null }); })
            .catch(() => { _promise = null; setState({ manifest: null, loading: false, error: 'unavailable' }); });
  }, []);

  return state;
}

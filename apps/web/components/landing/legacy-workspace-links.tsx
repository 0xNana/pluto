'use client';

import { useEffect } from 'react';
import { legacyWorkspaceDestination } from '../../lib/workspace-routes';

// Previously signed notices and saved bookmarks must still reach the app.
export function LegacyWorkspaceLinks() {
  useEffect(() => {
    const redirect = () => {
      const destination = legacyWorkspaceDestination(window.location.hash);
      if (destination) window.location.replace(destination);
    };
    redirect();
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
  }, []);
  return null;
}

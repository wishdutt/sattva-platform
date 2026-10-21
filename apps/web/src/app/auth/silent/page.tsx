'use client';

import { useEffect } from 'react';
import { oidcManager } from '@/lib/oidc';

/** Hidden-iframe target for silent token renewal (providers without refresh tokens). */
export default function OidcSilentPage() {
  useEffect(() => {
    void oidcManager().signinSilentCallback();
  }, []);
  return null;
}

import { createHash, randomBytes } from 'node:crypto';

/** Time-sortable, URL-safe id: 9 chars of base36 millis + 12 random chars. */
export function newId(prefix?: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(9).toString('base64url');
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

/** 256-bit single-use secret for invitation links. Only its hash is stored. */
export const newInvitationToken = () => randomBytes(32).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Revocation with an IETF Token Status List, using Credo's built-in TokenStatusList API.
// One list of 2-bit entries: 0 = valid, 1 = revoked (invalid), 2 = suspended.
// The list is a JWT signed with the SAME certificate as the credentials, so verifiers can trust it.
// mdoc (mDL) credentials need the same list as a CWT (ISO 18013-5 § 12.3.6), with an expiry time.
// Both copies always hold the same values: one licence has one index, in both lists.
import type { Agent } from './credo.ts';
import { StatusList } from '@owf/token-status-list';
import { MDOC_STATUS_LIST_URI, pki, STATUS_LIST_URI } from './agents.ts';

const RECORD_ID = 'status-list-1';
const LIST_LENGTH = 4096;
export const STATUS = { valid: 0, revoked: 1, suspended: 2 } as const;
export type StatusName = keyof typeof STATUS;

let lock: Promise<unknown> = Promise.resolve();
/** Run status-list changes one after another, so two revocations at once can't overwrite each other. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

const signer = () => ({ method: 'x5c' as const, x5c: [pki.authority] });

// The CWT copy must carry an expiry; we re-sign it well before that, so verifiers never see it expired.
const CWT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CWT_REFRESH_BEFORE_MS = 60 * 60 * 1000;
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/**
 * Build the CWT copy from the JWT list, which stays the single source of truth.
 * We never decode a CWT ourselves: Credo 0.7.4 bundles two versions of @owf/cose, and the mdoc one
 * registers its own COSE tag decoder, so updateTokenStatusList({ format: 'cwt' }) fails to read its own token.
 */
async function cwtFromJwt(agent: Agent, jwt: string) {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const { bits, lst } = payload.status_list as { bits: 1 | 2 | 4 | 8; lst: string };
  const statusList = StatusList.decompressStatusListFromBytes(new Uint8Array(Buffer.from(lst, 'base64url')), bits);
  const expiresAt = new Date(Date.now() + CWT_LIFETIME_MS);
  const created = await agent.tokenStatusList.createTokenStatusList({
    format: 'cwt',
    statusList,
    statusListUri: MDOC_STATUS_LIST_URI,
    signer: signer(),
    alg: 'ES256',
    timeToLive: 60,
    expiresAt,
  });
  return { cwt: toBase64(created.statusList as Uint8Array), cwtExpiresAt: expiresAt.toISOString() };
}

export async function initStatusList(agent: Agent) {
  const existing = await agent.genericRecords.findById(RECORD_ID);
  if (existing) {
    // Lists created before mdoc support have no CWT copy yet: build it from the JWT list.
    if (!existing.content.cwt) {
      existing.content = { ...existing.content, ...(await cwtFromJwt(agent, existing.content.token as string)) };
      await agent.genericRecords.update(existing);
    }
    return;
  }
  const created = await agent.tokenStatusList.createTokenStatusList({
    format: 'jwt',
    statusList: { statusListLength: LIST_LENGTH, bitsPerStatus: 2 },
    statusListUri: STATUS_LIST_URI,
    signer: signer(),
    alg: 'ES256',
    timeToLive: 60,
  });
  await agent.genericRecords.save({ id: RECORD_ID, content: { token: created.statusList, nextIndex: 0, ...(await cwtFromJwt(agent, created.statusList as string)) } });
}

/** Reserve the next index for a new credential. */
export function allocateIndex(agent: Agent): Promise<number> {
  return serialize(async () => {
    const record = (await agent.genericRecords.findById(RECORD_ID))!;
    const index = record.content.nextIndex as number;
    if (index >= LIST_LENGTH) throw new Error('Status list is full');
    record.content = { ...record.content, nextIndex: index + 1 };
    await agent.genericRecords.update(record);
    return index;
  });
}

/** Revoke, suspend or reinstate one credential: re-sign the list with the new value. */
export function setStatus(agent: Agent, index: number, status: StatusName): Promise<void> {
  return serialize(async () => {
    const record = (await agent.genericRecords.findById(RECORD_ID))!;
    const updated = await agent.tokenStatusList.updateTokenStatusList({
      format: 'jwt',
      token: record.content.token as string,
      status: { index, status: STATUS[status] },
      signer: signer(),
      alg: 'ES256',
      timeToLive: 60,
    });
    const cwt = await cwtFromJwt(agent, updated.statusList as string);
    record.content = { ...record.content, token: updated.statusList, ...cwt };
    await agent.genericRecords.update(record);
  });
}

export async function getStatusListToken(agent: Agent): Promise<string> {
  const record = await agent.genericRecords.findById(RECORD_ID);
  if (!record) throw new Error('Status list not initialised');
  return record.content.token as string;
}

/** The CWT copy for mdoc verifiers, re-signed when it gets close to its expiry. */
export async function getMdocStatusList(agent: Agent): Promise<Uint8Array> {
  const record = await agent.genericRecords.findById(RECORD_ID);
  if (!record?.content.cwt) throw new Error('Status list not initialised');
  if (Date.parse(record.content.cwtExpiresAt as string) - Date.now() > CWT_REFRESH_BEFORE_MS) {
    return fromBase64(record.content.cwt as string);
  }
  return serialize(async () => {
    const fresh = (await agent.genericRecords.findById(RECORD_ID))!;
    fresh.content = { ...fresh.content, ...(await cwtFromJwt(agent, fresh.content.token as string)) };
    await agent.genericRecords.update(fresh);
    return fromBase64(fresh.content.cwt as string);
  });
}

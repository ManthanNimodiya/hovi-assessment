// Revocation with an IETF Token Status List, using Credo's built-in TokenStatusList API.
// One list of 2-bit entries: 0 = valid, 1 = revoked (invalid), 2 = suspended.
// The list is a JWT signed with the SAME certificate as the credentials, so verifiers can trust it.
import type { Agent } from './credo.ts';
import { pki, STATUS_LIST_URI } from './agents.ts';

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

export async function initStatusList(agent: Agent) {
  const existing = await agent.genericRecords.findById(RECORD_ID);
  if (existing) return;
  const created = await agent.tokenStatusList.createTokenStatusList({
    format: 'jwt',
    statusList: { statusListLength: LIST_LENGTH, bitsPerStatus: 2 },
    statusListUri: STATUS_LIST_URI,
    signer: signer(),
    alg: 'ES256',
    timeToLive: 60,
  });
  await agent.genericRecords.save({ id: RECORD_ID, content: { token: created.statusList, nextIndex: 0 } });
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
    record.content = { ...record.content, token: updated.statusList };
    await agent.genericRecords.update(record);
  });
}

export async function getStatusListToken(agent: Agent): Promise<string> {
  const record = await agent.genericRecords.findById(RECORD_ID);
  if (!record) throw new Error('Status list not initialised');
  return record.content.token as string;
}

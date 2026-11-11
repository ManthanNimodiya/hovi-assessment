// The Licence Authority: issues driving licences (OpenID4VCI pre-authorized code flow) and revokes them.
import { randomUUID } from 'node:crypto';
import type { Agent } from './credo.ts';
import { TRUSTED_ISSUER_ID, UNTRUSTED_ISSUER_ID } from './agents.ts';
import { CATEGORIES, CATEGORY_MIN_AGE, LICENCE_CONFIG_ID, MAX_VALIDITY_YEARS, licenceClaims, type LicenceInput } from './licence.ts';
import { addYears, isRealDate, today } from './dates.ts';
import { allocateIndex, setStatus, type StatusName } from './statusList.ts';

export type LicenceRecord = {
  id: string;
  holderName: string;
  documentNumber: string;
  categories: string[];
  expiryDate: string;
  statusIndex: number;
  status: StatusName;
  issuer: 'trusted' | 'untrusted';
  issuanceSessionId: string;
  createdAt: string;
};

export class InputError extends Error {}

function validate(input: Partial<LicenceInput>): LicenceInput {
  const s = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new InputError(`${name} is required`);
    return v.trim().slice(0, 100);
  };
  const date = (v: unknown, name: string) => {
    const d = s(v, name);
    if (!isRealDate(d)) throw new InputError(`${name} must be a real date (YYYY-MM-DD)`);
    return d;
  };
  const categories = Array.isArray(input.categories) ? input.categories.filter((c) => typeof c === 'string' && c in CATEGORIES) : [];
  if (!categories.length) throw new InputError('Choose at least one licence category');
  const licence = {
    given_name: s(input.given_name, 'given_name'),
    family_name: s(input.family_name, 'family_name'),
    birth_date: date(input.birth_date, 'birth_date'),
    document_number: s(input.document_number, 'document_number'),
    issue_date: date(input.issue_date, 'issue_date'),
    expiry_date: date(input.expiry_date, 'expiry_date'),
    categories: [...new Set(categories)],
  };
  // The dates must make sense together, not just be well-formed.
  const now = today();
  if (licence.birth_date < '1900-01-01' || licence.birth_date >= now) throw new InputError('birth_date must be in the past');
  if (licence.issue_date > now) throw new InputError('issue_date cannot be in the future');
  const minAge = Math.max(...licence.categories.map((c) => CATEGORY_MIN_AGE[c] ?? 18));
  if (licence.issue_date < addYears(licence.birth_date, minAge)) {
    throw new InputError(`The holder must be at least ${minAge} on issue_date for these categories`);
  }
  if (licence.expiry_date <= licence.issue_date) throw new InputError('expiry_date must be after issue_date');
  if (licence.expiry_date > addYears(licence.issue_date, MAX_VALIDITY_YEARS)) {
    throw new InputError(`A licence can be valid for at most ${MAX_VALIDITY_YEARS} years`);
  }
  if (licence.expiry_date < now) throw new InputError('This licence has already expired');
  return licence;
}

export async function issueLicence(
  agent: Agent,
  rawInput: Partial<LicenceInput>,
  options: { untrusted?: boolean; requirePin?: boolean } = {},
) {
  const input = validate(rawInput);
  const statusIndex = await allocateIndex(agent);
  const issuerId = options.untrusted ? UNTRUSTED_ISSUER_ID : TRUSTED_ISSUER_ID;
  const expiresAt = Math.floor(Date.parse(`${input.expiry_date}T23:59:59Z`) / 1000);

  const { credentialOffer, issuanceSession } = await agent.openid4vc.issuer.createCredentialOffer({
    issuerId,
    credentialConfigurationIds: [LICENCE_CONFIG_ID],
    preAuthorizedCodeFlowConfig: {
      txCode: options.requirePin ? { input_mode: 'numeric', length: 4, description: 'PIN shown on the licence office screen' } : undefined,
    },
    // Stored with the issuance session; read back in the credential mapper (agents.ts).
    issuanceMetadata: { claims: licenceClaims(input), statusIndex, expiresAt },
  });

  const record: LicenceRecord = {
    id: randomUUID(),
    holderName: `${input.given_name} ${input.family_name}`,
    documentNumber: input.document_number,
    categories: input.categories,
    expiryDate: input.expiry_date,
    statusIndex,
    status: 'valid',
    issuer: options.untrusted ? 'untrusted' : 'trusted',
    issuanceSessionId: issuanceSession.id,
    createdAt: new Date().toISOString(),
  };
  await agent.genericRecords.save({ id: record.id, content: record, tags: { type: 'licence' } });

  return { licence: record, offerUri: credentialOffer, txCode: issuanceSession.userPin };
}

export async function listLicences(agent: Agent) {
  const records = await agent.genericRecords.findAllByQuery({ type: 'licence' });
  const licences = records.map((r) => r.content as LicenceRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Add whether each offer has been collected by a wallet yet.
  return Promise.all(
    licences.map(async (l) => {
      const session = await agent.openid4vc.issuer.getIssuanceSessionById(l.issuanceSessionId).catch(() => undefined);
      return { ...l, issuanceState: session?.state ?? 'Unknown' };
    }),
  );
}

export async function changeLicenceStatus(agent: Agent, id: string, status: StatusName) {
  const record = await agent.genericRecords.findById(id);
  if (!record || record.getTag('type') !== 'licence') return undefined;
  const licence = record.content as LicenceRecord;
  await setStatus(agent, licence.statusIndex, status);
  record.content = { ...licence, status };
  await agent.genericRecords.update(record);
  return record.content as LicenceRecord;
}

// The Car Rental company: asks for the licence (OpenID4VP + DCQL), then decides eligibility.
import { randomUUID } from 'node:crypto';
import { OpenId4VcVerificationSessionState, type Agent, type DcqlQuery } from './credo.ts';
import { pki, VERIFIER_ID } from './agents.ts';
import { InputError } from './authority.ts';
import { checkEligibility, LICENCE_VCT, RENTAL_REQUESTED_CLAIMS, VEHICLES, type Check } from './licence.ts';

export type RentalDecision = 'pending' | 'approved' | 'rejected' | 'expired';

/** What we keep about a rental. Only the decision and the minimum needed for the contract. */
export type RentalRecord = {
  id: string;
  vehicleId: string;
  startDate: string;
  endDate: string;
  verificationSessionId: string;
  decision: RentalDecision;
  reason?: string;
  checks?: Check[];
  driverName?: string; // needed on the rental contract
  createdAt: string;
  decidedAt?: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 30;

const licenceQuery: DcqlQuery = {
  credentials: [
    {
      id: 'driving_licence',
      format: 'dc+sd-jwt',
      meta: { vct_values: [LICENCE_VCT] },
      // Ask ONLY for what the decision needs. Birth date, address and document number are never requested.
      claims: RENTAL_REQUESTED_CLAIMS.map((claim) => ({ path: [claim] })),
    },
  ],
};

export async function createRental(agent: Agent, body: { vehicleId?: string; startDate?: string; endDate?: string }) {
  const vehicle = VEHICLES.find((v) => v.id === body.vehicleId);
  if (!vehicle) throw new InputError('Choose a vehicle');
  const { startDate, endDate } = body;
  if (!startDate || !endDate || !DATE.test(startDate) || !DATE.test(endDate)) throw new InputError('Choose start and end dates');
  const today = new Date().toISOString().slice(0, 10);
  if (startDate < today) throw new InputError('The rental cannot start in the past');
  if (endDate < startDate) throw new InputError('The end date must be on or after the start date');
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
  if (days > MAX_DAYS) throw new InputError(`Rentals are limited to ${MAX_DAYS} days`);

  const { authorizationRequest, verificationSession } = await agent.openid4vc.verifier.createAuthorizationRequest({
    verifierId: VERIFIER_ID,
    requestSigner: { method: 'x5c', x5c: [pki.verifier], clientIdPrefix: 'x509_san_dns' },
    dcql: { query: licenceQuery },
    responseMode: 'direct_post.jwt',
  });

  const rental: RentalRecord = {
    id: randomUUID(),
    vehicleId: vehicle.id,
    startDate,
    endDate,
    verificationSessionId: verificationSession.id,
    decision: 'pending',
    createdAt: new Date().toISOString(),
  };
  await agent.genericRecords.save({ id: rental.id, content: rental, tags: { type: 'rental' } });
  return { rental, requestUri: authorizationRequest };
}

/** Turn Credo's technical errors into a reason a customer understands. */
function explainError(message = ''): string {
  const m = message.toLowerCase();
  if (m.includes('status')) return 'The licence has been revoked or suspended by the issuing authority.';
  if (m.includes('trust') || m.includes('certificate') || m.includes('x5c')) return 'The licence was not issued by a trusted licence authority.';
  if (m.includes('expired') || m.includes('exp')) return 'The licence credential has expired.';
  if (m.includes('nonce') || m.includes('audience') || m.includes('key binding') || m.includes('kb-jwt'))
    return 'The licence was not presented by its owner for this rental session.';
  if (m.includes('access_denied') || m.includes('declined')) return 'You declined to share your licence.';
  return 'The licence could not be verified.';
}

export async function getRental(agent: Agent, id: string) {
  const record = await agent.genericRecords.findById(id);
  if (!record || record.getTag('type') !== 'rental') return undefined;
  let rental = record.content as RentalRecord;
  if (rental.decision !== 'pending') return rental;

  const session = await agent.openid4vc.verifier.getVerificationSessionById(rental.verificationSessionId);
  const save = async (patch: Partial<RentalRecord>) => {
    rental = { ...rental, ...patch, decidedAt: new Date().toISOString() };
    record.content = rental;
    await agent.genericRecords.update(record);
    // The session holds the full presentation; we don't need it once the decision is made.
    await agent.openid4vc.verifier.deleteVerificationSessionById(session.id).catch(() => undefined);
    return rental;
  };

  if (session.state === OpenId4VcVerificationSessionState.Error) {
    return save({ decision: 'rejected', reason: explainError(session.errorMessage) });
  }
  if (session.state !== OpenId4VcVerificationSessionState.ResponseVerified) {
    if (Date.now() - Date.parse(rental.createdAt) > 10 * 60_000) return save({ decision: 'expired', reason: 'The request expired.' });
    return rental;
  }

  // Signature, trust anchor, validity, holder binding (KB-JWT), nonce/audience and status list
  // were all checked by Credo before the session reached ResponseVerified.
  const verified = await agent.openid4vc.verifier.getVerifiedAuthorizationResponse(session.id);
  const presentation = verified.dcql?.presentations?.driving_licence?.[0] as { prettyClaims?: Record<string, unknown> } | undefined;
  const claims = presentation?.prettyClaims;
  if (!claims) return save({ decision: 'rejected', reason: 'No driving licence was shared.' });

  const vehicle = VEHICLES.find((v) => v.id === rental.vehicleId)!;
  const { eligible, checks } = checkEligibility(claims, vehicle, rental);
  return save({
    decision: eligible ? 'approved' : 'rejected',
    reason: eligible ? 'Your licence covers this vehicle for the whole rental.' : checks.find((c) => !c.ok)?.detail,
    checks,
    driverName: eligible ? `${claims.given_name ?? ''} ${claims.family_name ?? ''}`.trim() : undefined,
  });
}

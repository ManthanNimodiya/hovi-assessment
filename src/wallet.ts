// A small demo wallet (holder) so reviewers can test without a phone. Real EUDI wallets work too.
import {
  ClaimFormat,
  Kms,
  SdJwtVcRecord,
  preAuthorizedCodeGrantIdentifier,
  type Agent,
} from './credo.ts';

export async function receiveCredential(agent: Agent, offerUri: string, txCode?: string) {
  const offer = await agent.openid4vc.holder.resolveCredentialOffer(offerUri);
  if (!offer.credentialOfferPayload.grants?.[preAuthorizedCodeGrantIdentifier]) throw new Error('Only pre-authorized offers are supported');

  const token = await agent.openid4vc.holder.requestToken({ resolvedCredentialOffer: offer, txCode: txCode || undefined });
  const response = await agent.openid4vc.holder.requestCredentials({
    resolvedCredentialOffer: offer,
    ...token,
    credentialConfigurationIds: Object.keys(offer.offeredCredentialConfigurations),
    // Holder binding: a fresh P-256 key in the wallet; its public key ends up in the credential's cnf.
    credentialBindingResolver: async () => {
      const key = await agent.kms.createKey({ type: { kty: 'EC', crv: 'P-256' } });
      return { method: 'jwk', keys: [Kms.PublicJwk.fromPublicJwk(key.publicJwk)] };
    },
  });

  const stored = [];
  for (const c of response.credentials) {
    if (!(c.record instanceof SdJwtVcRecord)) continue;
    stored.push(await agent.sdJwtVc.store({ record: c.record }));
  }
  return stored.map(summarise);
}

function summarise(record: SdJwtVcRecord) {
  const sdJwt = record.firstCredential;
  const claims = sdJwt.prettyClaims as Record<string, unknown>;
  const header = sdJwt.header as { x5c?: string[] };
  return {
    id: record.id,
    vct: claims.vct,
    name: `${claims.given_name ?? ''} ${claims.family_name ?? ''}`.trim(),
    categories: Array.isArray(claims.driving_privileges)
      ? (claims.driving_privileges as { vehicle_category_code: string }[]).map((p) => p.vehicle_category_code)
      : [],
    expiryDate: claims.expiry_date,
    issuer: String(claims.iss ?? ''),
    issuerName: String(claims.iss ?? '').endsWith('/unofficial-licence-office')
      ? 'Unofficial Licence Office (untrusted)'
      : String(claims.issuing_authority ?? claims.iss ?? 'Unknown issuer'),
    signedByCertificate: header.x5c ? 'yes' : 'no',
    claims,
  };
}

export async function listCredentials(agent: Agent) {
  const records = await agent.sdJwtVc.getAll();
  return records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(summarise);
}

export async function deleteCredential(agent: Agent, id: string) {
  await agent.sdJwtVc.deleteById(id);
}

/** Read a presentation request and show what the verifier wants and which credentials match. */
export async function previewRequest(agent: Agent, requestUri: string) {
  const resolved = await agent.openid4vc.holder.resolveOpenId4VpAuthorizationRequest(requestUri);
  const query = resolved.dcql?.queryResult;
  const requested = resolved.dcql?.queryResult.credentials.flatMap((c: { claims?: { path: (string | number | null)[] }[] }) => (c.claims ?? []).map((cl) => cl.path.join('.'))) ?? [];
  const matches = query?.credential_matches.driving_licence;
  const matchingIds =
    matches && matches.success
      ? (matches.valid_credentials ?? []).map((vc: { record: unknown }) => (vc.record as SdJwtVcRecord).id)
      : [];
  const payload = resolved.authorizationRequestPayload as { client_id?: string; client_metadata?: { client_name?: string } };
  return {
    verifier: payload.client_metadata?.client_name ?? payload.client_id ?? 'Unknown verifier',
    clientId: payload.client_id,
    requestedClaims: requested,
    matchingCredentialIds: matchingIds,
  };
}

/** Share the chosen credential (only the requested claims are disclosed). */
export async function presentCredential(agent: Agent, requestUri: string, credentialId?: string) {
  const resolved = await agent.openid4vc.holder.resolveOpenId4VpAuthorizationRequest(requestUri);
  if (!resolved.dcql) throw new Error('This wallet only supports DCQL requests');
  const queryResult = resolved.dcql.queryResult;

  // Let the user pick which licence to share: keep only that one among the matches.
  if (credentialId) {
    const match = queryResult.credential_matches.driving_licence;
    if (match?.success && match.valid_credentials) {
      const chosen = match.valid_credentials.filter((vc: { record: unknown }) => (vc.record as SdJwtVcRecord).id === credentialId);
      if (!chosen.length) throw new Error('That credential does not match this request');
      match.valid_credentials = chosen as typeof match.valid_credentials;
    }
  }

  const credentials = agent.openid4vc.holder.selectCredentialsForDcqlRequest(queryResult);
  const result = await agent.openid4vc.holder.acceptOpenId4VpAuthorizationRequest({
    authorizationRequestPayload: resolved.authorizationRequestPayload,
    dcql: { credentials },
  });
  return { status: result.serverResponse?.status, ok: result.ok };
}

export { ClaimFormat };

/** Decline: tell the verifier the user refused (OpenID4VP error response with access_denied). */
export async function declineRequest(agent: Agent, requestUri: string) {
  const resolved = await agent.openid4vc.holder.resolveOpenId4VpAuthorizationRequest(requestUri);
  const payload = resolved.authorizationRequestPayload as { response_uri?: string; state?: string };
  if (!payload.response_uri) throw new Error('The request has no response_uri');
  const body = new URLSearchParams({ error: 'access_denied', error_description: 'The user declined to share' });
  if (payload.state) body.set('state', payload.state);
  const res = await fetch(payload.response_uri, { method: 'POST', body });
  return { status: res.status };
}

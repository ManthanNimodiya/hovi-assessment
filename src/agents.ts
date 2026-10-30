// Three Credo agents in one service, each with its own storage, like three separate organisations:
//   1. issuerAgent   – the Licence Authority (issues driving licences with OpenID4VCI, runs the status list)
//   2. verifierAgent – the Car Rental company (requests licences with OpenID4VP)
//   3. walletAgent   – a demo holder wallet, so the flow can be tested without a phone
import type { Express } from 'express';
import { mkdirSync } from 'node:fs';
import {
  Agent,
  AskarModule,
  ClaimFormat,
  ConsoleLogger,
  Kms,
  LogLevel,
  NativeAskar,
  OpenId4VcModule,
  X509Certificate,
  X509KeyUsage,
  X509Module,
  X509Service,
  agentDependencies,
  type OpenId4VciCredentialRequestToCredentialMapper,
} from './credo.ts';
import { config, hostname } from './config.ts';
import { credentialConfigurationsSupported, DISCLOSABLE, LICENCE_CONFIG_ID } from './licence.ts';

export const TRUSTED_ISSUER_ID = 'licence-authority';
export const UNTRUSTED_ISSUER_ID = 'unofficial-licence-office';
export const VERIFIER_ID = 'car-rental';
export const STATUS_LIST_URI = `${config.baseUrl}/status-lists/1`;

function askar(name: string) {
  let database;
  if (config.databaseUrl) {
    const u = new URL(config.databaseUrl);
    database = {
      type: 'postgres' as const,
      config: { host: `${u.hostname}:${u.port || 5432}` },
      credentials: { account: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
    };
  } else {
    mkdirSync(config.dataDir, { recursive: true });
    database = { type: 'sqlite' as const, config: { path: `${config.dataDir}/${name}.sqlite` } };
  }
  return new AskarModule({ askar: NativeAskar, store: { id: name, key: config.storeKey, database } });
}

const agentConfig = { allowInsecureHttpUrls: config.baseUrl.startsWith('http://'), logger: new ConsoleLogger(LogLevel.Warn) };

// ---------------------------------------------------------------------------------------------
// Certificates. The trust anchor (a demo CA) signs the Licence Authority's certificate.
// The rental company trusts ONLY the trust anchor. The "unofficial office" has a self-signed
// certificate that nobody trusts, so we can demonstrate rejection of untrusted issuers.
// ---------------------------------------------------------------------------------------------
export type IssuerPki = { trustAnchor: X509Certificate; authority: X509Certificate; unofficial: X509Certificate };
export const pki = {} as IssuerPki & { verifier: X509Certificate };

const VALIDITY = { notBefore: new Date('2025-01-01'), notAfter: new Date('2035-01-01') };

async function loadOrCreatePki(agent: Agent): Promise<IssuerPki> {
  const existing = await agent.genericRecords.findById('pki');
  if (existing && existing.content.hostname === hostname) {
    const c = existing.content as Record<string, string>;
    const load = (pem: string, keyId: string) => {
      const cert = X509Certificate.fromEncodedCertificate(pem);
      cert.keyId = keyId;
      return cert;
    };
    return {
      trustAnchor: load(c.trustAnchorPem, c.trustAnchorKeyId),
      authority: load(c.authorityPem, c.authorityKeyId),
      unofficial: load(c.unofficialPem, c.unofficialKeyId),
    };
  }

  const newKey = async () => {
    const key = await agent.kms.createKey({ type: { kty: 'EC', crv: 'P-256' } });
    return Kms.PublicJwk.fromPublicJwk(key.publicJwk);
  };
  const caKey = await newKey();
  const authorityKey = await newKey();
  const unofficialKey = await newKey();

  const trustAnchor = await X509Service.createCertificate(agent.context, {
    authorityKey: caKey,
    issuer: { countryName: 'FI', commonName: 'DriveProof Demo Trust Anchor (TEST)' },
    validity: VALIDITY,
    extensions: {
      basicConstraints: { ca: true, pathLenConstraint: 0 },
      keyUsage: { usages: [X509KeyUsage.KeyCertSign, X509KeyUsage.CrlSign] },
    },
  });
  const authority = await X509Service.createCertificate(agent.context, {
    authorityKey: caKey,
    subjectPublicKey: authorityKey,
    issuer: { countryName: 'FI', commonName: 'DriveProof Demo Trust Anchor (TEST)' },
    subject: { countryName: 'FI', commonName: 'Demo Transport Licence Authority (TEST)' },
    validity: VALIDITY,
    extensions: {
      keyUsage: { usages: [X509KeyUsage.DigitalSignature] },
      subjectAlternativeName: { name: [{ type: 'dns', value: hostname }, { type: 'url', value: config.baseUrl }] },
    },
  });
  const unofficial = await X509Service.createCertificate(agent.context, {
    authorityKey: unofficialKey,
    issuer: { countryName: 'FI', commonName: 'Unofficial Licence Office (UNTRUSTED TEST)' },
    validity: VALIDITY,
    extensions: {
      keyUsage: { usages: [X509KeyUsage.DigitalSignature] },
      subjectAlternativeName: { name: [{ type: 'dns', value: hostname }, { type: 'url', value: config.baseUrl }] },
    },
  });

  const content = {
    hostname,
    trustAnchorPem: trustAnchor.toString('pem'), trustAnchorKeyId: caKey.keyId,
    authorityPem: authority.toString('pem'), authorityKeyId: authorityKey.keyId,
    unofficialPem: unofficial.toString('pem'), unofficialKeyId: unofficialKey.keyId,
  };
  if (existing) {
    existing.content = content;
    await agent.genericRecords.update(existing);
  } else {
    await agent.genericRecords.save({ id: 'pki', content });
  }
  return { trustAnchor, authority, unofficial };
}

async function loadOrCreateVerifierCert(agent: Agent): Promise<X509Certificate> {
  const existing = await agent.genericRecords.findById('verifier-cert');
  if (existing && existing.content.hostname === hostname) {
    const cert = X509Certificate.fromEncodedCertificate(existing.content.pem as string);
    cert.keyId = existing.content.keyId as string;
    return cert;
  }
  const key = await agent.kms.createKey({ type: { kty: 'EC', crv: 'P-256' } });
  const publicJwk = Kms.PublicJwk.fromPublicJwk(key.publicJwk);
  const cert = await X509Service.createCertificate(agent.context, {
    authorityKey: publicJwk,
    issuer: { countryName: 'FI', commonName: 'DriveProof Car Rental (TEST)' },
    validity: VALIDITY,
    extensions: {
      keyUsage: { usages: [X509KeyUsage.DigitalSignature] },
      subjectAlternativeName: { name: [{ type: 'dns', value: hostname }] },
    },
  });
  const content = { hostname, pem: cert.toString('pem'), keyId: key.keyId };
  if (existing) {
    existing.content = content;
    await agent.genericRecords.update(existing);
  } else {
    await agent.genericRecords.save({ id: 'verifier-cert', content });
  }
  return cert;
}

// ---------------------------------------------------------------------------------------------
// What goes into each issued credential. Credo calls this when a wallet requests the credential.
// The licence data was stored in the issuance session when the offer was created.
// ---------------------------------------------------------------------------------------------
const credentialMapper: OpenId4VciCredentialRequestToCredentialMapper = async ({
  holderBinding,
  credentialConfigurationId,
  issuanceSession,
}) => {
  if (credentialConfigurationId !== LICENCE_CONFIG_ID) throw new Error(`Unsupported credential ${credentialConfigurationId}`);
  const meta = issuanceSession.issuanceMetadata as { claims: Record<string, unknown>; statusIndex: number; expiresAt: number };
  const untrusted = issuanceSession.issuerId === UNTRUSTED_ISSUER_ID;
  const cert = untrusted ? pki.unofficial : pki.authority;

  return {
    type: 'credentials',
    format: ClaimFormat.SdJwtDc,
    credentials: holderBinding.keys.map((binding) => ({
      payload: {
        vct: credentialConfigurationsSupported[LICENCE_CONFIG_ID].vct,
        ...meta.claims,
        exp: meta.expiresAt,
        // Revocation: where to look this credential up (IETF Token Status List). The list is signed by the
        // Licence Authority's certificate, so only its own credentials can point to it.
        ...(untrusted ? {} : { status: { status_list: { idx: meta.statusIndex, uri: STATUS_LIST_URI } } }),
      },
      holder: binding, // holder binding: the wallet's key goes into cnf
      issuer: { method: 'x5c' as const, x5c: [cert], issuer: `${config.baseUrl}/oid4vci/${issuanceSession.issuerId}` },
      disclosureFrame: { _sd: DISCLOSABLE },
    })),
  };
};

// ---------------------------------------------------------------------------------------------
export async function createAgents(app: Express) {
  const issuerAgent = new Agent({
    config: agentConfig,
    dependencies: agentDependencies,
    modules: {
      askar: askar('licence-authority'),
      openid4vc: new OpenId4VcModule({
        app,
        issuer: { baseUrl: `${config.baseUrl}/oid4vci`, credentialRequestToCredentialMapper: credentialMapper },
      }),
    },
  });

  const verifierAgent = new Agent({
    config: agentConfig,
    dependencies: agentDependencies,
    modules: {
      askar: askar('car-rental'),
      openid4vc: new OpenId4VcModule({ app, verifier: { baseUrl: `${config.baseUrl}/oid4vp` } }),
    },
  });

  const walletAgent = new Agent({
    config: agentConfig,
    dependencies: agentDependencies,
    modules: {
      askar: askar('demo-wallet'),
      openid4vc: new OpenId4VcModule({}),
      // A demo wallet accepts any issuer/verifier certificate. A production wallet would use EU trusted lists.
      x509: new X509Module({
        getTrustedCertificatesForVerification: (_ctx, { certificateChain }) => [
          certificateChain[certificateChain.length - 1].toString('pem'),
        ],
      }),
    },
  });

  await issuerAgent.initialize();
  await verifierAgent.initialize();
  await walletAgent.initialize();

  // Licence Authority: certificates + issuer records
  Object.assign(pki, await loadOrCreatePki(issuerAgent));
  for (const [issuerId, name] of [
    [TRUSTED_ISSUER_ID, 'Demo Transport Licence Authority'],
    [UNTRUSTED_ISSUER_ID, 'Unofficial Licence Office (untrusted)'],
  ] as const) {
    const existing = await issuerAgent.openid4vc.issuer.getAllIssuers();
    const found = existing.find((i) => i.issuerId === issuerId);
    if (found) {
      await issuerAgent.openid4vc.issuer.updateIssuerMetadata({
        issuerId,
        credentialConfigurationsSupported,
        display: [{ name, locale: 'en' }],
      });
    } else {
      await issuerAgent.openid4vc.issuer.createIssuer({
        issuerId,
        credentialConfigurationsSupported,
        display: [{ name, locale: 'en' }],
      });
    }
  }

  // Rental company: trust ONLY the trust anchor, and have a certificate to sign requests.
  verifierAgent.x509.config.setTrustedCertificates([pki.trustAnchor.toString('pem')]);
  pki.verifier = await loadOrCreateVerifierCert(verifierAgent);
  const verifiers = await verifierAgent.openid4vc.verifier.getAllVerifiers();
  if (!verifiers.find((v) => v.verifierId === VERIFIER_ID)) {
    await verifierAgent.openid4vc.verifier.createVerifier({
      verifierId: VERIFIER_ID,
      clientMetadata: { client_name: 'DriveProof Car Rental' },
    });
  }

  return { issuerAgent, verifierAgent, walletAgent };
}

export type Agents = Awaited<ReturnType<typeof createAgents>>;

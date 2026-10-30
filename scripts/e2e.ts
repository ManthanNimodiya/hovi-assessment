// End-to-end test against a running server: `npm start`, then `npm run e2e`.
// Covers the happy path and every rejection the assessment asks for.
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY ?? 'demo-admin-key' };

async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? text}`);
  return json;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const person = { given_name: 'Mikko', family_name: 'Testinen', birth_date: '1990-05-01', document_number: 'FI7654321', issue_date: '2020-01-01' };

async function issueAndReceive(extra: Record<string, unknown>) {
  const issued = await call('POST', '/authority/licences', { ...person, expiry_date: day(3650), categories: ['B'], requirePin: true, ...extra }, ADMIN);
  const [credential] = await call('POST', '/wallet/receive', { offerUri: issued.offerUri, txCode: issued.txCode });
  return { licenceId: issued.licence.id as string, credentialId: credential.id as string };
}

async function rent(vehicleId: string, credentialId: string, endOffset = 5) {
  const { rental, requestUri } = await call('POST', '/rentals', { vehicleId, startDate: day(1), endDate: day(endOffset) });
  await call('POST', '/wallet/present', { requestUri, credentialId }).catch(() => undefined); // wallet may get an error back
  return call('GET', `/rentals/${rental.id}`);
}

let failures = 0;
function expect(label: string, decision: string, result: { decision: string; reason?: string }) {
  const ok = result.decision === decision;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      → ${result.decision}: ${result.reason}`);
}

const valid = await issueAndReceive({});
expect('valid B licence, renting a car', 'approved', await rent('golf', valid.credentialId));
expect('same licence, renting a motorcycle (needs A)', 'rejected', await rent('mt07', valid.credentialId));

const truck = await issueAndReceive({ categories: ['B', 'C1'] });
expect('B + C1 licence, renting a 5 t van', 'approved', await rent('sprinter', truck.credentialId));

const expiring = await issueAndReceive({ expiry_date: day(3) });
expect('licence expiring during the rental', 'rejected', await rent('golf', expiring.credentialId, 5));

const young = await issueAndReceive({ given_name: 'Nuori', birth_date: day(-365 * 20), document_number: 'FI1111111' });
expect('20-year-old renting a Tesla (needs 21+)', 'rejected', await rent('model3', young.credentialId));

const untrusted = await issueAndReceive({ untrusted: true });
expect('licence from an untrusted issuer', 'rejected', await rent('golf', untrusted.credentialId));

const revoked = await issueAndReceive({});
expect('before revocation', 'approved', await rent('golf', revoked.credentialId));
await call('POST', `/authority/licences/${revoked.licenceId}/status`, { status: 'revoked' }, ADMIN);
expect('after revocation', 'rejected', await rent('golf', revoked.credentialId));
await call('POST', `/authority/licences/${revoked.licenceId}/status`, { status: 'valid' }, ADMIN);
expect('after reinstatement', 'approved', await rent('golf', revoked.credentialId));

{
  const { rental, requestUri } = await call('POST', '/rentals', { vehicleId: 'golf', startDate: day(1), endDate: day(3) });
  await call('POST', '/wallet/decline', { requestUri });
  expect('customer declines in the wallet', 'rejected', await call('GET', `/rentals/${rental.id}`));
}

try {
  await call('POST', '/authority/licences', { ...person, issue_date: '2010-01-01', expiry_date: '2020-01-01', categories: ['B'] }, ADMIN);
  failures++;
  console.log('FAIL  issuing an already-expired licence was allowed');
} catch (e) {
  console.log(`PASS  issuing an already-expired licence is refused\n      → ${(e as Error).message}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

// DriveProof: one service hosting the Licence Authority, the Car Rental company and a demo wallet.
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { config } from './config.ts';
import { createAgents } from './agents.ts';
import { changeLicenceStatus, InputError, issueLicence, listLicences } from './authority.ts';
import { CATEGORIES, LICENCE_VCT, VEHICLES } from './licence.ts';
import { createRental, getRental } from './rental.ts';
import { getStatusListToken, initStatusList, STATUS, type StatusName } from './statusList.ts';
import { declineRequest, deleteCredential, listCredentials, presentCredential, previewRequest, receiveCredential } from './wallet.ts';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Credo registers the OpenID4VCI (/oid4vci) and OpenID4VP (/oid4vp) endpoints on this app.
const { issuerAgent, verifierAgent, walletAgent } = await createAgents(app);
await initStatusList(issuerAgent);

const api = express.Router();
api.use(express.json({ limit: '50kb' }));

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const qr = (text: string) => QRCode.toDataURL(text, { margin: 1, width: 320 });

// ---------- Public info ----------
api.get('/meta', (_req, res) => {
  res.json({ baseUrl: config.baseUrl, vehicles: VEHICLES, categories: CATEGORIES, vct: LICENCE_VCT });
});

// ---------- Licence Authority (admin) ----------
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.header('x-admin-key') !== config.adminKey) {
    res.status(401).json({ error: 'Admin key missing or wrong' });
    return;
  }
  next();
};

api.post('/authority/licences', requireAdmin, asyncRoute(async (req, res) => {
  const { untrusted, requirePin, ...input } = req.body ?? {};
  const result = await issueLicence(issuerAgent, input, { untrusted: !!untrusted, requirePin: requirePin !== false });
  res.status(201).json({ ...result, offerQr: await qr(result.offerUri) });
}));

api.get('/authority/licences', requireAdmin, asyncRoute(async (_req, res) => {
  res.json(await listLicences(issuerAgent));
}));

api.post('/authority/licences/:id/status', requireAdmin, asyncRoute(async (req, res) => {
  const status = req.body?.status as StatusName;
  if (!(status in STATUS)) throw new InputError('status must be valid, revoked or suspended');
  const licence = await changeLicenceStatus(issuerAgent, String(req.params.id), status);
  if (!licence) {
    res.status(404).json({ error: 'Licence not found' });
    return;
  }
  res.json(licence);
}));

// ---------- Car Rental ----------
api.post('/rentals', asyncRoute(async (req, res) => {
  const { rental, requestUri } = await createRental(verifierAgent, req.body ?? {});
  res.status(201).json({ rental, requestUri, requestQr: await qr(requestUri) });
}));

api.get('/rentals/:id', asyncRoute(async (req, res) => {
  const rental = await getRental(verifierAgent, String(req.params.id));
  if (!rental) {
    res.status(404).json({ error: 'Rental not found' });
    return;
  }
  res.json(rental);
}));

// ---------- Demo wallet ----------
api.get('/wallet/credentials', asyncRoute(async (_req, res) => {
  res.json(await listCredentials(walletAgent));
}));
api.post('/wallet/receive', asyncRoute(async (req, res) => {
  const { offerUri, txCode } = req.body ?? {};
  if (typeof offerUri !== 'string') throw new InputError('offerUri is required');
  res.status(201).json(await receiveCredential(walletAgent, offerUri, txCode));
}));
api.post('/wallet/preview', asyncRoute(async (req, res) => {
  if (typeof req.body?.requestUri !== 'string') throw new InputError('requestUri is required');
  res.json(await previewRequest(walletAgent, req.body.requestUri));
}));
api.post('/wallet/present', asyncRoute(async (req, res) => {
  const { requestUri, credentialId } = req.body ?? {};
  if (typeof requestUri !== 'string') throw new InputError('requestUri is required');
  res.json(await presentCredential(walletAgent, requestUri, credentialId));
}));
api.post('/wallet/decline', asyncRoute(async (req, res) => {
  if (typeof req.body?.requestUri !== 'string') throw new InputError('requestUri is required');
  res.json(await declineRequest(walletAgent, req.body.requestUri));
}));
api.delete('/wallet/credentials/:id', asyncRoute(async (req, res) => {
  await deleteCredential(walletAgent, String(req.params.id));
  res.status(204).end();
}));

app.use('/api', api);

// ---------- Status list (public, fetched by verifiers) ----------
app.get('/status-lists/1', asyncRoute(async (_req, res) => {
  res.type('application/statuslist+jwt').set('Cache-Control', 'max-age=30').send(await getStatusListToken(issuerAgent));
}));

// Type metadata for the credential type (so wallets can display it).
app.get('/vct/driving-licence', (_req, res) => {
  res.json({ vct: LICENCE_VCT, name: 'Driving Licence', description: 'Demo digital driving licence (synthetic test data)' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(express.static('public', { extensions: ['html'] }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof InputError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Something went wrong' });
});

app.listen(config.port, () => {
  console.log(`DriveProof running at ${config.baseUrl}`);
});

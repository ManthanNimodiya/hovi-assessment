# DriveProof: digital driving licence for car rental

A working prototype where a customer gets a **digital driving licence** in their wallet and uses it to prove they may drive the
vehicle they want to rent, **for the whole rental period**. Built with **Credo-TS 0.7**, **OpenID4VCI** (issuance) and
**OpenID4VP + DCQL** (presentation), **SD-JWT VC** credentials, **X.509 trust anchors** and **IETF Token Status List** revocation.

- **Live demo:** _DEPLOYED_URL_
- **Try it in 2 minutes:** Licence office → issue → *Open in demo wallet* → enter PIN → Car rental → pick a vehicle and dates → *Open in demo wallet* → Share → see the decision.

All data is synthetic and every key, certificate and secret is a test value.

---

## What it does

| Party | Role | Page |
|---|---|---|
| **Demo Transport Licence Authority** | Issues licences (OpenID4VCI, pre-authorized code + PIN), revokes / suspends / reinstates them | `/authority` |
| **DriveProof Car Rental** | Customer picks a vehicle + dates, the wallet shares only the needed claims (OpenID4VP), the company decides eligibility | `/rent` |
| **Demo wallet** | A Credo holder wallet, so reviewers can test without a phone. Real EUDI wallets can scan the same QR codes | `/wallet` |
| *Unofficial Licence Office* | A second issuer **not** trusted by the rental company, to demonstrate rejection of untrusted credentials | `/authority` (checkbox) |

### The rental decision

1. **Credential checks (Credo):** the issuer's signature, **X.509 chain to the configured trust anchor**, validity (`exp`),
   **holder binding** (key-binding JWT signed by the key in `cnf`), **binding to this verification session** (nonce + audience),
   and **revocation status** (status list fetched and verified, signed by the same certificate as the credential).
2. **Business rules (our code):** the licence must
   - not expire before the **return date**,
   - include the vehicle's **category** (car = B, 5 t van = C1, motorcycle = A), not expiring before the return date,
   - show the driver is **old enough** (18+ or 21+ depending on the vehicle).
3. The customer sees **approved / rejected with every check explained**, or a clear reason when the credential itself fails
   (revoked, untrusted issuer, declined, expired).

## Architecture

```mermaid
flowchart LR
  subgraph Service["DriveProof service (one Docker container)"]
    LA["Licence Authority agent\n(Credo issuer)"]
    CR["Car Rental agent\n(Credo verifier)"]
    DW["Demo wallet agent\n(Credo holder)"]
    SL[("Status list JWT\n/status-lists/1")]
    UI["Web UI\n/authority /rent /wallet"]
  end
  DB[("Askar storage\nSQLite or Postgres\n(one database per organisation)")]
  W["Any EUDI wallet\n(e.g. Hovi Wallet)"]
  LA -- "OpenID4VCI\n/oid4vci" --> DW
  LA -- "OpenID4VCI" --> W
  DW -- "OpenID4VP\n/oid4vp" --> CR
  W -- "OpenID4VP" --> CR
  CR -- "fetch + verify" --> SL
  LA -- "signs" --> SL
  LA & CR & DW --- DB
```

- **Three separate Credo agents** in one process, each with **its own storage**, so the issuer, verifier and wallet never
  share keys or data, as if they were three organisations. Splitting them into three services later only means changing URLs.
- **PKI:** a demo **trust anchor (CA)** signs the Licence Authority's certificate. The rental company trusts **only the trust anchor**
  (`verifierAgent.x509.config.setTrustedCertificates`). The unofficial office has a self-signed certificate, so it's rejected.
  The rental company signs its OpenID4VP requests with its own certificate (`x509_san_dns` client id).
- **Credential:** SD-JWT VC (`dc+sd-jwt`), claims modelled on the ISO 18013-5 / EUDI mobile driving licence data set
  (`driving_privileges`, `expiry_date`, `age_over_18/21/25`, …). **Every claim is selectively disclosable.**
- **Revocation:** Credo's `TokenStatusList` API (2 bits per credential: valid / revoked / suspended), signed with the issuer's
  certificate and served at `/status-lists/1`. Status changes are serialised so two revocations can't overwrite each other.

### Data minimisation

- The rental company asks (DCQL) for only `given_name`, `family_name`, `expiry_date`, `driving_privileges`, `age_over_18`, `age_over_21`.
  **Birth date, address and licence number are never requested.** Age is proven with `age_over_*` booleans.
- After deciding, it stores only the **decision, the checks and the driver's name** (needed for the contract), and **deletes the
  verification session** that held the presentation.
- The licence authority keeps a minimal registry (holder name, licence number, categories, expiry, status index).

## Code map

```
src/
  index.ts       Express server: API routes, status list endpoint, static UI
  agents.ts      The three Credo agents, PKI (trust anchor + certificates), credential mapper
  licence.ts     Credential configuration, claims, vehicles, eligibility rules
  authority.ts   Issue licences (createCredentialOffer), list, revoke / suspend / reinstate
  statusList.ts  Token status list: create, allocate index, update status (serialised)
  rental.ts      Create OpenID4VP request (DCQL), read verified response, apply rules, store decision
  wallet.ts      Demo wallet: receive (OpenID4VCI), preview / present / decline (OpenID4VP)
  config.ts      Environment configuration
public/          Web UI (plain HTML + JS, no build step)
scripts/e2e.ts   End-to-end test of every scenario against a running server
```

## Run it

Requires **Node.js 22+**.

```bash
npm install
cp .env.example .env      # optional, defaults work locally
npm start                 # http://localhost:3000
npm run e2e               # in a second terminal: runs all scenarios
```

**Docker:** `docker build -t driveproof . && docker run -p 3000:3000 driveproof`
**Docker + Postgres:** `docker compose up --build`

### Environment variables (`.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:3000` | Public URL. Wallets must reach it; use the HTTPS URL when deployed |
| `ADMIN_KEY` | `demo-admin-key` | Protects licence authority admin actions (issue, revoke). Test value |
| `STORE_KEY` | `driveproof-test-store-key` | Encryption key for the Askar stores. Test value |
| `DATABASE_URL` | *(empty → SQLite in `./data`)* | `postgres://user:password@host:5432/db` to use Postgres |

### Deploy (Koyeb)

1. Create a **Web Service** from this GitHub repo, builder **Dockerfile**, port **3000**.
2. Optional: create a **Koyeb Postgres** database and set `DATABASE_URL`.
3. Set `BASE_URL` to the service's public URL (e.g. `https://<service>-<org>.koyeb.app`), plus `ADMIN_KEY` and `STORE_KEY`.

## Tested scenarios (`npm run e2e`)

| Scenario | Expected |
|---|---|
| Valid B licence, renting a car | ✅ approved |
| Same licence, renting a motorcycle (needs A) | ❌ wrong category |
| B + C1 licence, renting a 5 t van | ✅ approved |
| Licence expiring during the rental | ❌ expires before return date |
| 20-year-old renting a Tesla (needs 21+) | ❌ age |
| Licence from the untrusted office | ❌ not issued by a trusted authority |
| Revoke → present again | ❌ revoked; reinstate → ✅ approved |
| Issuing an already-expired licence | refused (400) |
| Customer declines in the wallet | ❌ declined (OpenID4VP `access_denied`) |

## Assumptions and design decisions

- **SD-JWT VC over mdoc:** easier to inspect and debug in an 8-hour prototype, supported by Credo end to end and by EUDI wallets.
  The design maps directly to mdoc (`org.iso.18013.5.1.mDL`) because the claims follow the same data set.
- **Pre-authorized code + PIN:** the licence office has already identified the person at the counter, so the wallet gets a code plus
  a PIN shown separately. A real authority would use the authorization code flow with eID login.
- **One service, three agents:** fastest to deploy and demo. Separate stores keep the trust boundaries realistic.
- **Demo wallet trusts any issuer certificate:** a real wallet would use the EU trusted lists. The **verifier** is strict and trusts only the trust anchor.
- **Admin key in a header** protects the authority's actions. A real system would use proper staff login and audit logs.
- **Status list `ttl` 60 s:** revocation reaches verifiers within about a minute while limiting load on the issuer.

## Not done / next steps

- mdoc (ISO 18013-5) format and proximity (NFC/BLE) presentation for pick-up at the counter.
- Real wallet testing beyond the demo wallet (the deployed HTTPS URL is required for phone wallets).
- Staff authentication, audit log, rate limiting, key storage in an HSM/KMS.
- Payment and booking: the prototype stops at the eligibility decision.

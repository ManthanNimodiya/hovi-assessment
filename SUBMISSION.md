# DriveProof: submission summary

**Repository:** https://github.com/ManthanNimodiya/hovi-assessment
**Deployed app:** https://driveproof-u5z6.onrender.com (free tier: the first request after 15 minutes idle takes about a minute to wake up)
**Run locally:** `npm install && npm start` → http://localhost:3000, then `npm run e2e` for all scenarios.
**Environment:** see `.env.example`. All values are test values. Defaults work locally with no `.env`.

## Solution summary

DriveProof is an end-to-end prototype with three parties, each a separate **Credo-TS 0.7** agent with its own storage:

- **Licence Authority** issues a digital driving licence as an **SD-JWT VC** using **OpenID4VCI** (pre-authorized code + PIN).
  Claims follow the ISO 18013-5 / EUDI mobile driving licence data set. Every claim is selectively disclosable.
  It signs with an **X.509 certificate chained to a demo trust anchor**, and supports **revocation, suspension and
  reinstatement** through a backend action that updates a signed **IETF Token Status List**.
- **Car Rental company:** the customer picks a vehicle and dates. The company sends an **OpenID4VP** request with a **DCQL**
  query for only the needed claims, signed with its own certificate. Credo verifies the signature, the **trust anchor**,
  validity, **holder binding** (key-binding JWT), the **session binding** (nonce + audience) and the **status list**. Then
  business rules check that the licence **covers the vehicle category and stays valid for the whole rental period**, and that
  the driver is **old enough**. The customer sees approved or rejected, with every check explained.
- **Demo wallet** (Credo holder) so the flow can be tested without a phone. It can choose which licence to share and decline.
  Real EUDI wallets can use the same QR codes on the deployed HTTPS URL.

Failure cases are all handled and covered by an automated end-to-end test (`scripts/e2e.ts`, 11 checks): wrong category,
licence expiring during the rental, under-age driver, **untrusted issuer**, **revoked** licence (and reinstated), declined
sharing, and refusing to issue an already-expired licence. The project is Dockerised (`Dockerfile`, `docker-compose.yml`
with Postgres, `render.yaml`) and runs on SQLite or Postgres.

## Business value for the customer

- **Faster, cheaper counter process:** no manual inspection of plastic licences or photocopies. Eligibility is checked
  in seconds, before the customer even reaches the desk, so it also works for self-service pick-up and unstaffed locations.
- **Less fraud and liability:** forged or altered licences fail the signature check, licences from unknown issuers are
  rejected, and **revoked or suspended licences are caught at rental time**, which a visual check can't do.
- **Fewer failed pick-ups:** the decision checks the licence category, expiry and age **for the whole rental period**
  at booking time, so customers learn about a problem before they travel.
- **Privacy by design and GDPR compliance:** the company asks for 6 claims only (no birth date, address or licence number)
  and keeps only the decision and the driver's name. Less stored personal data means less breach risk and compliance cost.
- **Ready for the EUDI Wallet:** built on OpenID4VCI/VP, SD-JWT VC and X.509 trust, the standards the EU wallet uses.
  Large services must accept EUDI wallets from December 2027, and the same integration then works with every EU country's wallet.

## How AI was used

- **Tools:** Claude Code (Anthropic, model Claude Opus 5.5) in the terminal and its built-in browser.
- **Approach:** I read the assessment and decided the scope and architecture (three agents, SD-JWT VC, X.509 trust anchor,
  status lists, business rules, data minimisation). The AI read the official **Credo 0.7.4 demo** and source to use the
  correct APIs (they changed since 0.5), then generated the code in small steps.
- **Verification:** every step was run and tested locally. An automated end-to-end test covers every scenario (11 checks).
  Strict TypeScript type checking passes, the UI was tested in the browser, and the Postgres storage mode was tested
  against a local Postgres 16. Problems found during testing were fixed (for example, credentials from the untrusted
  issuer must not reference the authority's status list).
- **Ownership:** I reviewed the code and can explain every file, design decision and trade-off.
- The AI also helped draft the README and these summaries.

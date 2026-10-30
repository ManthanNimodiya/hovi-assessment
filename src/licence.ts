// The digital driving licence: credential definition, claims, and the rental eligibility rules.
import { Kms, OpenId4VciCredentialFormatProfile, type OpenId4VciCredentialConfigurationsSupportedWithFormats } from './credo.ts';
import { config } from './config.ts';

export const LICENCE_CONFIG_ID = 'DrivingLicence-sdjwt';
export const LICENCE_VCT = `${config.baseUrl}/vct/driving-licence`;

/** Licence categories (EU driving licence categories, simplified). */
export const CATEGORIES: Record<string, string> = {
  AM: 'Moped',
  A: 'Motorcycle',
  B: 'Car',
  BE: 'Car with trailer',
  C1: 'Light truck / large van (3.5–7.5 t)',
  C: 'Truck',
  D1: 'Minibus',
};

export const credentialConfigurationsSupported = {
  [LICENCE_CONFIG_ID]: {
    format: OpenId4VciCredentialFormatProfile.SdJwtDc,
    vct: LICENCE_VCT,
    scope: 'driving_licence',
    cryptographic_binding_methods_supported: ['jwk'],
    credential_signing_alg_values_supported: [Kms.KnownJwaSignatureAlgorithms.ES256],
    proof_types_supported: {
      jwt: { proof_signing_alg_values_supported: [Kms.KnownJwaSignatureAlgorithms.ES256, Kms.KnownJwaSignatureAlgorithms.EdDSA] },
    },
    credential_metadata: {
      display: [{ name: 'Driving Licence', locale: 'en', background_color: '#12355b', text_color: '#ffffff' }],
    },
  },
} satisfies OpenId4VciCredentialConfigurationsSupportedWithFormats;

export type DrivingPrivilege = { vehicle_category_code: string; issue_date: string; expiry_date: string };

/** What the licence authority knows about one licence holder (synthetic data only). */
export type LicenceInput = {
  given_name: string;
  family_name: string;
  birth_date: string; // YYYY-MM-DD
  document_number: string;
  issue_date: string;
  expiry_date: string;
  categories: string[];
};

export function ageOn(birthDate: string, on: Date): number {
  const b = new Date(`${birthDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

/** Claims of the SD-JWT VC, modelled on the ISO 18013-5 / EUDI mobile driving licence data set. */
export function licenceClaims(l: LicenceInput) {
  const age = ageOn(l.birth_date, new Date());
  return {
    given_name: l.given_name,
    family_name: l.family_name,
    birth_date: l.birth_date,
    age_over_18: age >= 18,
    age_over_21: age >= 21,
    age_over_25: age >= 25,
    document_number: l.document_number,
    issuing_country: 'FI',
    issuing_authority: 'Demo Transport Licence Authority',
    issue_date: l.issue_date,
    expiry_date: l.expiry_date,
    driving_privileges: l.categories.map(
      (c): DrivingPrivilege => ({ vehicle_category_code: c, issue_date: l.issue_date, expiry_date: l.expiry_date }),
    ),
  };
}

/** Every claim is selectively disclosable, so a verifier only sees what it asks for. */
export const DISCLOSABLE = [
  'given_name', 'family_name', 'birth_date', 'age_over_18', 'age_over_21', 'age_over_25',
  'document_number', 'issuing_country', 'issuing_authority', 'issue_date', 'expiry_date', 'driving_privileges',
];

// ---------------- Rental side ----------------

export type Vehicle = {
  id: string;
  name: string;
  kind: string;
  category: string; // licence category needed
  minAge: number;
  pricePerDay: number;
  image: string;
};

export const VEHICLES: Vehicle[] = [
  { id: 'golf', name: 'Volkswagen Golf', kind: 'Compact car', category: 'B', minAge: 18, pricePerDay: 49, image: '🚗' },
  { id: 'model3', name: 'Tesla Model 3', kind: 'Electric premium car', category: 'B', minAge: 21, pricePerDay: 89, image: '⚡' },
  { id: 'sprinter', name: 'Mercedes Sprinter 5t', kind: 'Large van (5 t)', category: 'C1', minAge: 21, pricePerDay: 119, image: '🚚' },
  { id: 'mt07', name: 'Yamaha MT-07', kind: 'Motorcycle', category: 'A', minAge: 21, pricePerDay: 69, image: '🏍️' },
];

/** The claims the rental company asks for: only what the decision needs (data minimisation). */
export const RENTAL_REQUESTED_CLAIMS = ['given_name', 'family_name', 'expiry_date', 'driving_privileges', 'age_over_18', 'age_over_21'];

export type Check = { name: string; ok: boolean; detail: string };

/** Business rules: the licence must cover this vehicle for the WHOLE rental period. */
export function checkEligibility(
  claims: Record<string, unknown>,
  vehicle: Vehicle,
  rental: { startDate: string; endDate: string },
): { eligible: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const end = rental.endDate;

  const expiry = typeof claims.expiry_date === 'string' ? claims.expiry_date : undefined;
  checks.push({
    name: 'Licence valid for the whole rental',
    ok: !!expiry && expiry >= end,
    detail: expiry ? `Licence expires ${expiry}, rental ends ${end}` : 'Expiry date was not shared',
  });

  const privileges = Array.isArray(claims.driving_privileges) ? (claims.driving_privileges as DrivingPrivilege[]) : [];
  const privilege = privileges.find((p) => p.vehicle_category_code === vehicle.category);
  checks.push({
    name: `Category ${vehicle.category} (${CATEGORIES[vehicle.category] ?? vehicle.category})`,
    ok: !!privilege && (!privilege.expiry_date || privilege.expiry_date >= end),
    detail: privilege
      ? privilege.expiry_date && privilege.expiry_date < end
        ? `Category ${vehicle.category} expires ${privilege.expiry_date}, before the rental ends`
        : `Licence includes category ${vehicle.category}`
      : `Licence categories: ${privileges.map((p) => p.vehicle_category_code).join(', ') || 'none shared'}`,
  });

  const ageClaim = vehicle.minAge >= 21 ? 'age_over_21' : 'age_over_18';
  checks.push({
    name: `Driver aged ${vehicle.minAge}+`,
    ok: claims[ageClaim] === true,
    detail: claims[ageClaim] === true ? `${ageClaim} = true` : `${ageClaim} is ${String(claims[ageClaim] ?? 'not shared')}`,
  });

  return { eligible: checks.every((c) => c.ok), checks };
}

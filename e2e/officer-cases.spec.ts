import { test, expect, Page, Route } from '@playwright/test';

/**
 * E2E tests for the Field Officer case workflow (/officer/cases*).
 *
 * The app is backend-driven and talks to environment.apiUrl (http://localhost:8000).
 * To keep these tests deterministic and independent of a live backend, every
 * `${API}/...` request is intercepted with page.route and served a canned response.
 */

const API = 'http://localhost:8000';
const GRID_TIMEOUT = 20_000;

const OFFICER = {
  token: 'fake-jwt-officer',
  name: 'Olivia Officer',
  role: 'field_officer',
};

// ── Fixture data (snake_case, matching the real backend contract) ────────────

const CASES_LIST = [
  {
    id: 1,
    case_ref: 'CASE-001',
    status: 'Draft',
    customer_name: 'Alice Applicant',
    verification_type: 'PAN Card',
    site_id: 'ABCDE1234F',
    assigned_officer: 'Olivia Officer',
    captured_at: '2026-10-01T09:00:00Z',
  },
  {
    id: 2,
    case_ref: 'CASE-002',
    status: 'Submitted',
    customer_name: 'Bob Builder',
    verification_type: 'Aadhaar Card',
    site_id: '1234 5678 9012',
    assigned_officer: 'Olivia Officer',
    captured_at: '2026-10-02T09:00:00Z',
  },
];

const CASE_001_DETAIL = {
  id: 1,
  case_ref: 'CASE-001',
  status: 'Draft',
  customer_name: 'Alice Applicant',
  site_address: '42 Example Street',
  site_id: 'ABCDE1234F',
  contact: '555-0100',
  verification_type: 'PAN Card',
  notes: 'Initial draft',
  photos: [],
  documents: [],
  ai_results: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed an authenticated field-officer session into localStorage. */
async function loginAsOfficer(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(u => {
    localStorage.setItem('token', u.token);
    localStorage.setItem('username', u.name);
    localStorage.setItem('role', u.role);
  }, OFFICER);
}

async function clearAuth(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
  });
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Intercept the case endpoints the officer screens use. */
async function mockCaseApi(page: Page): Promise<void> {
  // GET /cases  → list
  await page.route(`${API}/cases`, route => {
    if (route.request().method() === 'GET') return json(route, CASES_LIST);
    // POST /cases → create returns a new Draft detail
    const payload = JSON.parse(route.request().postData() || '{}');
    return json(route, {
      ...CASE_001_DETAIL,
      id: 99,
      case_ref: 'CASE-099',
      status: 'Draft',
      customer_name: payload.customer_name,
      site_address: payload.site_address,
    });
  });

  // GET /cases/CASE-001 → detail
  await page.route(`${API}/cases/CASE-001`, route => json(route, CASE_001_DETAIL));
  await page.route(`${API}/cases/CASE-099`, route => json(route, {
    ...CASE_001_DETAIL,
    id: 99,
    case_ref: 'CASE-099',
  }));
}

// ── Auth / role guard ─────────────────────────────────────────────────────────

test.describe('Officer cases – auth & role guard', () => {
  test('redirects an unauthenticated user to /login', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/officer/cases');
    await expect(page).toHaveURL(/\/login/);
  });

  test('allows a field_officer to reach the case list', async ({ page }) => {
    await mockCaseApi(page);
    await loginAsOfficer(page);
    await page.goto('/officer/cases');
    await expect(page).toHaveURL(/\/officer\/cases/);
    await expect(page.getByRole('heading', { name: 'My Cases' })).toBeVisible();
  });

  test('redirects a wrong-role user away from /officer/cases', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.setItem('token', 'fake-jwt-front');
      localStorage.setItem('username', 'Fiona Front');
      localStorage.setItem('role', 'front_office');
    });
    await page.goto('/officer/cases');
    // roleGuard sends non-matching roles to homeRoute() → /office/overview
    await expect(page).not.toHaveURL(/\/officer\/cases/);
  });
});

// ── Case list ──────────────────────────────────────────────────────────────────

test.describe('Officer case list', () => {
  test.beforeEach(async ({ page }) => {
    await mockCaseApi(page);
    await loginAsOfficer(page);
    await page.goto('/officer/cases');
  });

  test('renders the AG Grid with the mocked cases', async ({ page }) => {
    await expect(page.locator('ag-grid-angular')).toBeVisible();
    await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: GRID_TIMEOUT });
    expect(await page.locator('.ag-row').count()).toBe(CASES_LIST.length);
  });

  test('shows the expected column headers', async ({ page }) => {
    await expect(page.locator('.ag-header-cell').filter({ hasText: 'Case Ref' })).toBeVisible();
    await expect(page.locator('.ag-header-cell').filter({ hasText: 'Applicant' })).toBeVisible();
    await expect(page.locator('.ag-header-cell').filter({ hasText: 'Status' })).toBeVisible();
  });

  test('shows a case ref from the data', async ({ page }) => {
    await expect(page.locator('.ag-cell').filter({ hasText: 'CASE-001' })).toBeVisible({
      timeout: GRID_TIMEOUT,
    });
  });

  test('quick-filter narrows the grid to a single matching row', async ({ page }) => {
    await expect(page.locator('.ag-row')).toHaveCount(2, { timeout: GRID_TIMEOUT });
    await page.getByPlaceholder('Search cases…').fill('Alice');
    await expect(page.locator('.ag-row')).toHaveCount(1);
    await expect(page.locator('.ag-cell').filter({ hasText: 'Alice Applicant' })).toBeVisible();
  });

  test('clicking a row opens that case in the form', async ({ page }) => {
    const row = page.locator('.ag-row').filter({ hasText: 'CASE-001' }).first();
    await expect(row).toBeVisible({ timeout: GRID_TIMEOUT });
    await row.click();
    await expect(page).toHaveURL(/\/officer\/cases\/CASE-001/);
    await expect(page.getByRole('heading', { name: /Case CASE-001/ })).toBeVisible();
  });

  test('"New case" button navigates to the create form', async ({ page }) => {
    await page.getByRole('button', { name: /New case/i }).click();
    await expect(page).toHaveURL(/\/officer\/cases\/new/);
    await expect(page.getByRole('heading', { name: /New Card Verification/i })).toBeVisible();
  });
});

// ── New case form ──────────────────────────────────────────────────────────────

test.describe('Officer new-case form', () => {
  test.beforeEach(async ({ page }) => {
    await mockCaseApi(page);
    await loginAsOfficer(page);
    await page.goto('/officer/cases/new');
  });

  test('shows required applicant and address fields', async ({ page }) => {
    await expect(page.locator('#cd-customer')).toBeVisible();
    await expect(page.locator('#cd-address')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create case' })).toBeVisible();
  });

  test('blocks creation and shows a validation error when required fields are empty', async ({ page }) => {
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.locator('.alert-danger')).toContainText(
      /Applicant name and address are required/i
    );
    // Still on the new form, not navigated to a created case
    await expect(page).toHaveURL(/\/officer\/cases\/new/);
  });

  test('creates a case and navigates to the saved case ref', async ({ page }) => {
    await page.locator('#cd-customer').fill('Carol Customer');
    await page.locator('#cd-address').fill('99 New Road');

    await Promise.all([
      page.waitForURL('**/officer/cases/CASE-099'),
      page.getByRole('button', { name: 'Create case' }).click(),
    ]);

    await expect(page).toHaveURL(/\/officer\/cases\/CASE-099/);
  });
});

// ── Existing case form ──────────────────────────────────────────────────────────

test.describe('Officer existing-case form', () => {
  test.beforeEach(async ({ page }) => {
    await mockCaseApi(page);
    await loginAsOfficer(page);
  });

  test('loads an existing case and pre-fills the detail fields', async ({ page }) => {
    const [response] = await Promise.all([
      // Match the backend XHR specifically (API host), not the SPA navigation
      page.waitForResponse(r => r.url() === `${API}/cases/CASE-001` && r.status() === 200),
      page.goto('/officer/cases/CASE-001'),
    ]);
    const detail = await response.json();
    expect(detail.case_ref).toBe('CASE-001');

    await expect(page.locator('#cd-customer')).toHaveValue('Alice Applicant');
    await expect(page.locator('#cd-address')).toHaveValue('42 Example Street');
    await expect(page.locator('#cd-siteid')).toHaveValue('ABCDE1234F');
    await expect(page.getByRole('heading', { name: /Case CASE-001/ })).toBeVisible();
  });

  test('"Back to cases" returns to the list', async ({ page }) => {
    await page.goto('/officer/cases/CASE-001');
    await page.getByRole('button', { name: 'Back to cases' }).click();
    await expect(page).toHaveURL(/\/officer\/cases$/);
    await expect(page.getByRole('heading', { name: 'My Cases' })).toBeVisible();
  });
});

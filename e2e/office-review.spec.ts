import { test, expect, Page, Route } from '@playwright/test';

/**
 * E2E tests for the Front Office feature set:
 *   /office/overview   – KPI dashboard + status chart + all-cases grid
 *   /office/review     – review queue (Submitted cases)
 *   /office/review/:ref – case review + approve / reject / request-correction
 *   /office/completed  – completed cases list
 *
 * The backend (environment.apiUrl = http://localhost:8000) is mocked with
 * page.route so the tests are deterministic and need no live API.
 */

const API = 'http://localhost:8000';
const GRID_TIMEOUT = 20_000;

const FRONT = {
  token: 'fake-jwt-front',
  name: 'Fiona Front',
  role: 'front_office',
};

// ── Fixture data (snake_case backend contract) ───────────────────────────────

const STATS = {
  total: 12,
  draft: 2,
  submitted: 4,
  needs_correction: 1,
  rejected: 2,
  completed: 3,
};

const SUBMITTED_CASES = [
  {
    id: 10,
    case_ref: 'CASE-010',
    status: 'Submitted',
    customer_name: 'Dana Submitter',
    verification_type: 'PAN Card',
    site_id: 'ABCDE1234F',
    assigned_officer: 'Olivia Officer',
    captured_at: '2026-10-03T09:00:00Z',
  },
  {
    id: 11,
    case_ref: 'CASE-011',
    status: 'Submitted',
    customer_name: 'Evan Entrant',
    verification_type: 'Aadhaar Card',
    site_id: '1234 5678 9012',
    assigned_officer: 'Olivia Officer',
    captured_at: '2026-10-04T09:00:00Z',
  },
];

const COMPLETED_CASES = [
  {
    id: 20,
    case_ref: 'CASE-020',
    status: 'Completed',
    customer_name: 'Gina Done',
    verification_type: 'Passport',
    site_id: 'A1234567',
    assigned_officer: 'Olivia Officer',
    captured_at: '2026-09-30T09:00:00Z',
  },
];

const CASE_010_DETAIL = {
  id: 10,
  case_ref: 'CASE-010',
  status: 'Submitted',
  customer_name: 'Dana Submitter',
  site_address: '7 Review Lane',
  site_id: 'ABCDE1234F',
  contact: '555-0200',
  verification_type: 'PAN Card',
  notes: 'Awaiting review',
  gps_status: 'captured',
  latitude: 12.34,
  longitude: 56.78,
  assigned_officer: 'Olivia Officer',
  captured_at: '2026-10-03T09:00:00Z',
  photos: [],
  documents: [],
  ai_results: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loginAsFront(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(u => {
    localStorage.setItem('token', u.token);
    localStorage.setItem('username', u.name);
    localStorage.setItem('role', u.role);
  }, FRONT);
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

/**
 * Mock every case endpoint the office screens touch.
 * `captured` collects decision POSTs so tests can assert what was sent.
 */
async function mockOfficeApi(
  page: Page,
  captured: { action?: string; comment?: string } = {}
): Promise<void> {
  await page.route(`${API}/cases/stats`, route => json(route, STATS));

  // GET /cases?status=... → filtered lists. Bare GET → all submitted (overview).
  await page.route(`${API}/cases**`, route => {
    const url = new URL(route.request().url());
    // Only handle the collection endpoint here, not /cases/<ref> or /cases/stats
    if (url.pathname !== '/cases') return route.fallback();
    const status = url.searchParams.get('status');
    if (status === 'Completed') return json(route, COMPLETED_CASES);
    return json(route, SUBMITTED_CASES);
  });

  // GET /cases/CASE-010 → detail
  await page.route(`${API}/cases/CASE-010`, route => json(route, CASE_010_DETAIL));

  // Decision endpoints: approve / reject / request-correction
  for (const action of ['approve', 'reject', 'request-correction']) {
    await page.route(`${API}/cases/CASE-010/${action}`, route => {
      captured.action = action;
      captured.comment = JSON.parse(route.request().postData() || '{}').comment;
      return json(route, { ...CASE_010_DETAIL, status: 'Completed' });
    });
  }
}

// ── Auth / role guard ─────────────────────────────────────────────────────────

test.describe('Office – auth & role guard', () => {
  test('redirects an unauthenticated user to /login', async ({ page }) => {
    await clearAuth(page);
    await page.goto('/office/review');
    await expect(page).toHaveURL(/\/login/);
  });

  test('allows a front_office user into the review queue', async ({ page }) => {
    await mockOfficeApi(page);
    await loginAsFront(page);
    await page.goto('/office/review');
    await expect(page).toHaveURL(/\/office\/review/);
    await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();
  });
});

// ── Overview / KPI dashboard ────────────────────────────────────────────────

test.describe('Office overview dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await mockOfficeApi(page);
    await loginAsFront(page);
    await page.goto('/office/overview');
  });

  test('shows the KPI cards with values from the stats endpoint', async ({ page }) => {
    await expect(page.locator('.kpi-total .kpi-value')).toHaveText(String(STATS.total));
    await expect(page.locator('.kpi-submitted .kpi-value')).toHaveText(String(STATS.submitted));
    await expect(page.locator('.kpi-completed .kpi-value')).toHaveText(String(STATS.completed));
  });

  test('renders the status chart component', async ({ page }) => {
    await expect(page.locator('app-pmr-chart')).toBeVisible();
  });

  test('renders the all-cases grid with data', async ({ page }) => {
    await expect(page.locator('ag-grid-angular')).toBeVisible();
    await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: GRID_TIMEOUT });
    expect(await page.locator('.ag-row').count()).toBeGreaterThan(0);
  });

  test('clicking a row opens the case review page', async ({ page }) => {
    const row = page.locator('.ag-row').filter({ hasText: 'CASE-010' }).first();
    await expect(row).toBeVisible({ timeout: GRID_TIMEOUT });
    await row.click();
    await expect(page).toHaveURL(/\/office\/review\/CASE-010/);
  });
});

// ── Review queue ───────────────────────────────────────────────────────────────

test.describe('Office review queue', () => {
  test.beforeEach(async ({ page }) => {
    await mockOfficeApi(page);
    await loginAsFront(page);
    await page.goto('/office/review');
  });

  test('lists only submitted cases', async ({ page }) => {
    await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: GRID_TIMEOUT });
    expect(await page.locator('.ag-row').count()).toBe(SUBMITTED_CASES.length);
    await expect(page.locator('.ag-cell').filter({ hasText: 'CASE-010' })).toBeVisible();
  });

  test('clicking a queued case opens its review', async ({ page }) => {
    const row = page.locator('.ag-row').filter({ hasText: 'CASE-010' }).first();
    await expect(row).toBeVisible({ timeout: GRID_TIMEOUT });
    await row.click();
    await expect(page).toHaveURL(/\/office\/review\/CASE-010/);
    await expect(page.getByRole('heading', { name: /Review CASE-010/ })).toBeVisible();
  });
});

// ── Case review + decisions ─────────────────────────────────────────────────

test.describe('Office case review', () => {
  test.beforeEach(async ({ page }) => {
    await mockOfficeApi(page);
    await loginAsFront(page);
  });

  test('loads the submitted case details read-only', async ({ page }) => {
    await page.goto('/office/review/CASE-010');
    await expect(page.getByRole('heading', { name: /Review CASE-010/ })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: 'Dana Submitter' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: '7 Review Lane' })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: 'ABCDE1234F' })).toBeVisible();
  });

  test('shows the three decision actions', async ({ page }) => {
    await page.goto('/office/review/CASE-010');
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request correction' })).toBeVisible();
  });

  test('approve navigates back to the queue', async ({ page }) => {
    const captured: { action?: string; comment?: string } = {};
    await mockOfficeApi(page, captured);
    await page.goto('/office/review/CASE-010');

    await page.getByRole('button', { name: 'Approve' }).click();
    await Promise.all([
      page.waitForURL('**/office/review'),
      page.getByRole('button', { name: /Confirm approve/ }).click(),
    ]);
    await expect(page).toHaveURL(/\/office\/review$/);
    expect(captured.action).toBe('approve');
  });

  test('reject requires a comment before confirming', async ({ page }) => {
    await page.goto('/office/review/CASE-010');
    await page.getByRole('button', { name: 'Reject' }).click();

    // Confirm with empty comment → validation error, stays on the page
    await page.getByRole('button', { name: /Confirm reject/ }).click();
    await expect(page.locator('.alert-danger')).toContainText(/comment is required/i);
    await expect(page).toHaveURL(/\/office\/review\/CASE-010/);
  });

  test('reject with a comment sends the comment and returns to the queue', async ({ page }) => {
    const captured: { action?: string; comment?: string } = {};
    await mockOfficeApi(page, captured);
    await page.goto('/office/review/CASE-010');

    await page.getByRole('button', { name: 'Reject' }).click();
    await page.locator('#rv-comment').fill('Blurry card photo');
    await Promise.all([
      page.waitForURL('**/office/review'),
      page.getByRole('button', { name: /Confirm reject/ }).click(),
    ]);
    expect(captured.action).toBe('reject');
    expect(captured.comment).toBe('Blurry card photo');
  });

  test('request correction sends the request and returns to the queue', async ({ page }) => {
    const captured: { action?: string; comment?: string } = {};
    await mockOfficeApi(page, captured);
    await page.goto('/office/review/CASE-010');

    await page.getByRole('button', { name: 'Request correction' }).click();
    await page.locator('#rv-comment').fill('Please re-upload the address proof');
    await Promise.all([
      page.waitForURL('**/office/review'),
      page.getByRole('button', { name: /Confirm request-correction/ }).click(),
    ]);
    expect(captured.action).toBe('request-correction');
    expect(captured.comment).toBe('Please re-upload the address proof');
  });

  test('cancelling an action hides the comment form', async ({ page }) => {
    await page.goto('/office/review/CASE-010');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('#rv-comment')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#rv-comment')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  });

  test('"Back to queue" returns to the review queue', async ({ page }) => {
    await page.goto('/office/review/CASE-010');
    await page.getByRole('button', { name: 'Back to queue' }).click();
    await expect(page).toHaveURL(/\/office\/review$/);
  });
});

// ── Completed cases ──────────────────────────────────────────────────────────

test.describe('Office completed cases', () => {
  test.beforeEach(async ({ page }) => {
    await mockOfficeApi(page);
    await loginAsFront(page);
    await page.goto('/office/completed');
  });

  test('shows the completed cases heading and grid', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Completed Cases' })).toBeVisible();
    await expect(page.locator('ag-grid-angular')).toBeVisible();
  });

  test('lists the completed case', async ({ page }) => {
    await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: GRID_TIMEOUT });
    await expect(page.locator('.ag-cell').filter({ hasText: 'CASE-020' })).toBeVisible();
  });
});

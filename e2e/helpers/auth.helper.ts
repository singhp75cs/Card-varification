import { Page, Route } from '@playwright/test';

const API = 'http://localhost:8000';

/**
 * Demo user used across the auth tests. The backend is MOCKED (see mockAuthApi),
 * so these are just the values the fake endpoints echo back — no live server
 * is required to run the auth specs.
 */
export const VALID_USER = {
  email: 'officer@example.com',
  password: 'pwd',
  name: 'Fatima Noor',
  role: 'field_officer',
};

/** Where the app sends a user after a successful login (AuthService.homeRoute). */
export const HOME_ROUTE = '/office/overview';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Intercept the auth endpoints so the login/signup flows work without a live
 * FastAPI backend.
 *
 *  - POST /auth/login    → 200 for VALID_USER creds, 401 otherwise
 *  - POST /auth/register → 201 normally, 409 for an "already registered" email
 *
 * Pass `existingEmails` to simulate the duplicate-email (409) case.
 */
export async function mockAuthApi(
  page: Page,
  opts: { existingEmails?: string[] } = {}
): Promise<void> {
  const existing = new Set(opts.existingEmails ?? []);

  await page.route(`${API}/auth/login`, route => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.email === VALID_USER.email && body.password === VALID_USER.password) {
      return json(route, {
        access_token: 'mock-jwt-token',
        token_type: 'bearer',
        user_name: VALID_USER.name,
        user_role: VALID_USER.role,
        user_id: 2,
      });
    }
    return json(route, { detail: 'Invalid email or password' }, 401);
  });

  await page.route(`${API}/auth/register`, route => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (existing.has(body.email)) {
      return json(route, { detail: 'Email already registered' }, 409);
    }
    return json(
      route,
      {
        access_token: 'mock-jwt-token',
        token_type: 'bearer',
        user_name: body.name,
        user_role: body.role || 'field_officer',
        user_id: 99,
      },
      201
    );
  });
}

/**
 * Logs in through the UI (with the backend mocked) and waits for the
 * post-login redirect to the office overview.
 */
export async function loginViaUI(page: Page): Promise<void> {
  await mockAuthApi(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(VALID_USER.email);
  await page.getByLabel('Password').fill(VALID_USER.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL('**/office/overview');
}

/**
 * Injects a fake auth session straight into localStorage so tests that only
 * need an authenticated state can skip the login UI entirely.
 */
export async function loginViaStorage(
  page: Page,
  user: { token?: string; name?: string; role?: string } = {}
): Promise<void> {
  await page.goto('/login'); // need an origin before touching localStorage
  await page.evaluate(
    u => {
      localStorage.setItem('token', u.token);
      localStorage.setItem('username', u.name);
      localStorage.setItem('role', u.role);
    },
    {
      token: user.token ?? 'fake-jwt-token',
      name: user.name ?? VALID_USER.name,
      role: user.role ?? VALID_USER.role,
    }
  );
}

/** Clears auth state from localStorage. */
export async function logout(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
  });
}

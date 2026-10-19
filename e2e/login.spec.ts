import { test, expect } from '@playwright/test';
import { VALID_USER, HOME_ROUTE, mockAuthApi, loginViaUI, logout } from './helpers/auth.helper';

/**
 * Login page tests. The backend is MOCKED with page.route (see auth.helper),
 * so these run deterministically with no live FastAPI server required.
 */

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthApi(page);
    await logout(page); // navigates to /login and clears storage
  });

  // ── Layout ──────────────────────────────────────────────────────────────

  test('displays the login form with all required elements', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    await expect(page.locator('a', { hasText: 'Register here' })).toBeVisible();
  });

  test('Login button is disabled when the form is empty', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Login' })).toBeDisabled();
  });

  test('Login button is disabled when only email is filled', async ({ page }) => {
    await page.getByLabel('Email').fill(VALID_USER.email);
    await expect(page.getByRole('button', { name: 'Login' })).toBeDisabled();
  });

  test('Login button is disabled when only password is filled', async ({ page }) => {
    await page.getByLabel('Password').fill(VALID_USER.password);
    await expect(page.getByRole('button', { name: 'Login' })).toBeDisabled();
  });

  test('Login button is enabled when both fields are filled', async ({ page }) => {
    await page.getByLabel('Email').fill(VALID_USER.email);
    await page.getByLabel('Password').fill(VALID_USER.password);
    await expect(page.getByRole('button', { name: 'Login' })).toBeEnabled();
  });

  // ── Successful login ──────────────────────────────────────────────────────

  test('redirects to the office overview on valid credentials', async ({ page }) => {
    await loginViaUI(page);
    await expect(page).toHaveURL(new RegExp(HOME_ROUTE));
  });

  test('stores token, username and role in localStorage after login', async ({ page }) => {
    await loginViaUI(page);

    const token = await page.evaluate(() => localStorage.getItem('token'));
    const username = await page.evaluate(() => localStorage.getItem('username'));
    const role = await page.evaluate(() => localStorage.getItem('role'));

    expect(token).toBeTruthy();
    expect(username).toBe(VALID_USER.name);
    expect(role).toBe(VALID_USER.role);
  });

  // ── Failed login ──────────────────────────────────────────────────────────

  test('shows an error message on wrong password', async ({ page }) => {
    await page.getByLabel('Email').fill(VALID_USER.email);
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.locator('.alert-danger')).toBeVisible();
    // Mocked backend returns 401; the HttpClient error message carries the status.
    await expect(page.locator('.alert-danger')).toContainText(/401/);
  });

  test('shows an error message on unknown email', async ({ page }) => {
    await page.getByLabel('Email').fill('unknown@example.com');
    await page.getByLabel('Password').fill('anypassword');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.locator('.alert-danger')).toBeVisible();
    await expect(page.locator('.alert-danger')).toContainText(/401/);
  });

  test('does not navigate away on failed login', async ({ page }) => {
    await page.getByLabel('Email').fill('bad@example.com');
    await page.getByLabel('Password').fill('badpass');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.locator('.alert-danger')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('does not store a token on failed login', async ({ page }) => {
    await page.getByLabel('Email').fill('bad@example.com');
    await page.getByLabel('Password').fill('badpass');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.locator('.alert-danger')).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeNull();
  });

  // ── Navigation ──────────────────────────────────────────────────────────

  test('navigates to the signup page via the Register here link', async ({ page }) => {
    await page.locator('a', { hasText: 'Register here' }).click();
    await expect(page).toHaveURL(/\/signup/);
  });

  test('redirects / to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});

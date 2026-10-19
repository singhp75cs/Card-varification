import { test, expect } from '@playwright/test';
import { HOME_ROUTE, mockAuthApi } from './helpers/auth.helper';

/**
 * Signup page tests. The backend is MOCKED with page.route (see auth.helper),
 * so these run deterministically with no live FastAPI server required.
 */

const uniqueEmail = () => `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;

test.describe('Signup Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthApi(page);
    await page.goto('/signup');
  });

  // ── Layout ──────────────────────────────────────────────────────────────

  test('displays the registration form with all required elements', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Register' })).toBeVisible();
    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByLabel('Role')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
    await expect(page.locator('a', { hasText: 'Login Page' })).toBeVisible();
  });

  test('Register button is disabled when the form is empty', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  test('Register button is disabled with only the name filled', async ({ page }) => {
    await page.getByLabel('Name').fill('Alice');
    await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  test('Register button is disabled with name and email but no password', async ({ page }) => {
    await page.getByLabel('Name').fill('Alice');
    await page.getByLabel('Email').fill('alice@example.com');
    await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  test('Register button is enabled when all fields are filled', async ({ page }) => {
    await page.getByLabel('Name').fill('Alice');
    await page.getByLabel('Email').fill('alice@example.com');
    await page.getByLabel('Password').fill('password123');
    await expect(page.getByRole('button', { name: 'Register' })).toBeEnabled();
  });

  test('offers the field_officer and front_office roles', async ({ page }) => {
    const options = page.locator('#signup-role option');
    await expect(options.filter({ hasText: 'field_officer' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'front_office' })).toHaveCount(1);
  });

  // ── Successful registration ─────────────────────────────────────────────

  test('registers a new user and redirects to the office overview', async ({ page }) => {
    await page.getByLabel('Name').fill('Alice E2E');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: 'Register' }).click();

    await page.waitForURL(`**${HOME_ROUTE}`);
    await expect(page).toHaveURL(new RegExp(HOME_ROUTE));
  });

  test('stores the session after a successful registration', async ({ page }) => {
    await page.getByLabel('Name').fill('Bob E2E');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel('Password').fill('password123');
    await page.getByLabel('Role').selectOption('front_office');
    await page.getByRole('button', { name: 'Register' }).click();

    await page.waitForURL(`**${HOME_ROUTE}`);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const role = await page.evaluate(() => localStorage.getItem('role'));
    expect(token).toBeTruthy();
    expect(role).toBe('front_office');
  });

  test('shows an error when registering a duplicate email', async ({ page }) => {
    const dupe = 'officer@example.com';
    // Re-mock so this email is treated as already registered (409).
    await mockAuthApi(page, { existingEmails: [dupe] });

    await page.getByLabel('Name').fill('Dup User');
    await page.getByLabel('Email').fill(dupe);
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page.locator('.alert-danger')).toBeVisible();
    await expect(page.locator('.alert-danger')).toContainText(/already registered/i);
    await expect(page).toHaveURL(/\/signup/);
  });

  // ── Navigation ──────────────────────────────────────────────────────────

  test('navigates to the login page via the Login Page link', async ({ page }) => {
    await page.locator('a', { hasText: 'Login Page' }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('stays on /signup when visited directly', async ({ page }) => {
    await expect(page).toHaveURL(/\/signup/);
    await expect(page.getByRole('heading', { name: 'Register' })).toBeVisible();
  });
});

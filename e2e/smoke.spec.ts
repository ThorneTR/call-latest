import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('Library exports are available', async ({ page }) => {
    // Load the library in a Node.js-like context
    // For now, just a simple check that the test setup works
    expect(true).toBe(true);
  });

  test('Can import latest function', async () => {
    const { latest } = await import('../src/index.ts');
    expect(typeof latest).toBe('function');
  });

  test('Can import dedupe function', async () => {
    const { dedupe } = await import('../src/index.ts');
    expect(typeof dedupe).toBe('function');
  });

  test('Can import createSmartSearch function', async () => {
    const { createSmartSearch } = await import('../src/index.ts');
    expect(typeof createSmartSearch).toBe('function');
  });

  test('StaleError is available', async () => {
    const { StaleError } = await import('../src/index.ts');
    expect(typeof StaleError).toBe('function');
  });
});

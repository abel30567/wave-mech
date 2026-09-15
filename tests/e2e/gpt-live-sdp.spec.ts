import { expect, test } from '@playwright/test';

test('native trial offer negotiates one audio stream and the control data channel', async ({ page }) => {
  let offerSections: { audio: number; data: number } | null = null;
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.gptLiveTrial = { enabled: true, hasApiKey: true, budgetRemainingUsd: 5, maxSessionSeconds: 30 };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route('**/api/gpt-live/session', async route => {
    const { sdp } = route.request().postDataJSON() as { sdp: string };
    offerSections = {
      audio: (sdp.match(/^m=audio /gm) ?? []).length,
      data: (sdp.match(/^m=application /gm) ?? []).length,
    };
    // Exercise native offer construction without creating a provider session.
    await route.fulfill({ status: 503, body: 'Synthetic provider refusal.' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start GPT-Live trial', exact: true }).click();
  await expect.poll(() => offerSections).not.toBeNull();
  expect(offerSections).toEqual({ audio: 1, data: 1 });
});

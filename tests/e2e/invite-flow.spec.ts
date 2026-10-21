import { expect, test, type Browser, type Page } from '@playwright/test';

const API = 'http://localhost:4000';
const unique = () => Math.random().toString(36).slice(2, 8);

async function devSignIn(page: Page, email: string, role: 'organizer' | 'viewer') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Platform role').selectOption(role);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/events$/);
}

async function newUser(browser: Browser, email: string, role: 'organizer' | 'viewer') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await devSignIn(page, email, role);
  return page;
}

async function latestInviteLink(to: string): Promise<string> {
  const res = await fetch(`${API}/dev/outbox`);
  const outbox = (await res.json()) as { to: string; text: string }[];
  const mail = [...outbox].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`No invitation email for ${to}`);
  return mail.text.match(/https?:\/\/\S+\/invite\?token=[\w-]+/)![0];
}

test('organizer creates an event, invites a viewer, and the viewer accepts', async ({ browser }) => {
  const id = unique();
  const organizerEmail = `org-${id}@example.com`;
  const viewerEmail = `viewer-${id}@example.com`;
  const title = `E2E Town Hall ${id}`;

  // Organizer creates the event.
  const organizer = await newUser(browser, organizerEmail, 'organizer');
  await organizer.getByRole('link', { name: 'New event' }).click();
  await organizer.getByLabel('Title').fill(title);
  await organizer.getByRole('button', { name: 'Create event' }).click();
  await expect(organizer.getByRole('heading', { name: title })).toBeVisible();
  const eventUrl = organizer.url();

  // Invites a viewer by email.
  await organizer.getByLabel('Email addresses').fill(viewerEmail);
  await organizer.getByRole('button', { name: 'Send invitations' }).click();
  await expect(organizer.getByText('1 invitation sent')).toBeVisible();
  await expect(organizer.getByText(viewerEmail)).toBeVisible();

  // A stranger cannot open the event even with its URL.
  const stranger = await newUser(browser, `stranger-${id}@example.com`, 'viewer');
  await stranger.goto(eventUrl);
  await expect(stranger.getByText('Event unavailable')).toBeVisible();

  // The stranger cannot use the invitation link either (email mismatch).
  const link = await latestInviteLink(viewerEmail);
  await stranger.goto(link);
  await expect(stranger.getByText("This invitation can't be used")).toBeVisible();

  // The invited viewer signs in, accepts, and lands on the event.
  const viewer = await newUser(browser, viewerEmail, 'viewer');
  await viewer.goto(link);
  await expect(viewer.getByRole('heading', { name: title })).toBeVisible();
  await viewer.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(viewer).toHaveURL(eventUrl);
  await expect(viewer.getByText('You will be able to join once the host goes live')).toBeVisible();

  // Before the event is live the viewer sees the waiting screen.
  await viewer.goto(`${eventUrl}/live`);
  await expect(viewer.getByText('Not started')).toBeVisible();

  // The viewer's dashboard lists the event; the organizer cannot be impersonated by URL.
  await viewer.goto('/events');
  await expect(viewer.getByText(title)).toBeVisible();
  await viewer.goto(`${eventUrl}/studio`);
  await expect(viewer.getByText('Hosts only')).toBeVisible();
});

test('invitation link used a second time is rejected', async ({ browser }) => {
  const id = unique();
  const organizer = await newUser(browser, `org2-${id}@example.com`, 'organizer');
  await organizer.getByRole('link', { name: 'New event' }).click();
  await organizer.getByLabel('Title').fill(`Single use ${id}`);
  await organizer.getByRole('button', { name: 'Create event' }).click();
  const viewerEmail = `once-${id}@example.com`;
  await organizer.getByLabel('Email addresses').fill(viewerEmail);
  await organizer.getByRole('button', { name: 'Send invitations' }).click();
  await expect(organizer.getByText('1 invitation sent')).toBeVisible();

  const link = await latestInviteLink(viewerEmail);
  const viewer = await newUser(browser, viewerEmail, 'viewer');
  await viewer.goto(link);
  await viewer.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(viewer).toHaveURL(/\/events\//);

  // Revisiting the consumed link as another account fails.
  const other = await newUser(browser, `other-${id}@example.com`, 'viewer');
  await other.goto(link);
  await expect(other.getByText("This invitation can't be used")).toBeVisible();
});

test.describe('live media (requires LiveKit credentials)', () => {
  test.skip(!process.env.LIVEKIT_URL, 'Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET for the API to run media tests');

  test('broadcaster goes live and an invited viewer receives video', async ({ browser }) => {
    const id = unique();
    const organizer = await newUser(browser, `host-${id}@example.com`, 'organizer');
    await organizer.getByRole('link', { name: 'New event' }).click();
    await organizer.getByLabel('Title').fill(`Live ${id}`);
    await organizer.getByRole('button', { name: 'Create event' }).click();
    const eventUrl = organizer.url();
    const viewerEmail = `watch-${id}@example.com`;
    await organizer.getByLabel('Email addresses').fill(viewerEmail);
    await organizer.getByRole('button', { name: 'Send invitations' }).click();
    await expect(organizer.getByText('1 invitation sent')).toBeVisible();

    await organizer.goto(`${eventUrl}/studio`);
    await organizer.getByRole('button', { name: 'Enable camera & microphone' }).click();
    await organizer.getByRole('button', { name: 'Enter backstage' }).click();
    await organizer.getByRole('button', { name: 'Go live' }).click();
    await expect(organizer.getByText('You are live')).toBeVisible();

    const viewer = await newUser(browser, viewerEmail, 'viewer');
    await viewer.goto(await latestInviteLink(viewerEmail));
    await viewer.getByRole('button', { name: 'Accept invitation' }).click();
    await viewer.goto(`${eventUrl}/live`);
    await viewer.getByRole('button', { name: 'Join live event' }).click();
    await expect(viewer.locator('video')).toBeVisible({ timeout: 20_000 });

    // Raise hand -> host approves -> viewer gets stage controls.
    await viewer.getByRole('button', { name: 'Raise hand' }).click();
    await organizer.getByRole('button', { name: /^Approve / }).click();
    await expect(viewer.getByRole('button', { name: 'Unmute microphone' })).toBeVisible({ timeout: 15_000 });
  });
});

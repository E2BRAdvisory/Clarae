import type { Page } from '@playwright/test';
import { expect, test, uuid, vault, type Cloud, type CloudSeed } from './cloud';
import { scene } from './drawingHelpers';
import { appOrigin, onWeb, proseMirror, seedVault } from './support';

// Live presence on a shared vault (M25, ADR-0065), on both targets of the e2e matrix: the avatars of the other
// people take the place of the "New application" button in the toolbar of the explorer (four and a +N), and
// their pointers are drawn over the note (Source and Live), the drawing and the canvas, in the colour of their
// avatar, until they leave or the file changes. What the user's own pointer sends is a position in the document.
//
//  - desktop-mock: the Wails mock's PresenceAPI (window.__mock.presence) plays the core;
//  - web-core: the real Go core in WebAssembly opens its WebSocket (`GET /api/v1/presence`) to the dev server of the
//    E2E build, which plays the cloud's side (web/scripts/e2ePresence.mjs): the core's own mapping of file to room,
//    its frames, its events.

const HOME = uuid(1);
const seed: CloudSeed = { vaults: [vault(HOME, 'Home', 'shared')] };
const FILES = {
  'Note.md': '# Title\n\nFirst paragraph of the note.\n\nSecond paragraph.\n',
  'Other.md': '# Other\n\nelsewhere\n',
  'Sketch.excalidraw': scene([]),
  'Map.canvas': JSON.stringify({
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'Alpha' }],
    edges: [],
  }),
};

interface Person {
  sid: string;
  userId: string;
  name: string;
}
// (the core lists the people by session id: they are numbered in the order the spec expects)
const ADA: Person = { sid: 's1', userId: 'u-ada', name: 'Ada Lovelace' };
const BOB: Person = { sid: 's2', userId: 'u-bob', name: 'Bob Stone' };
const MORE: Person[] = ['Cy Young', 'Di Hall', 'Ed Poe', 'Flo Reed'].map((name, i) => ({
  sid: `s${i + 3}`,
  userId: `u-${name.split(' ')[0]!.toLowerCase()}`,
  name,
}));

type Pos = { line: number; col: number } | { x: number; y: number };
interface Sent {
  kind: string;
  line: number;
  col: number;
  x: number;
  y: number;
}

/** The other side: who is in the open file and where they point, and what the user's pointer sent. */
interface Presence {
  members(path: string, list: Person[]): Promise<void>;
  move(path: string, sid: string, pos: Pos): Promise<void>;
  cleared(path: string): Promise<void>;
  /** What the UI watches now (count of files held). */
  watched(): Promise<number>;
  sent(): Promise<Sent[]>;
}

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string } }>;
    presence: {
      watches: Map<string, number>;
      moves: { pos: Sent }[];
      members(vaultId: string, path: string, list: Person[]): void;
      move(vaultId: string, path: string, sid: string, pos: Pos): void;
      cleared(vaultId: string, path: string): void;
    };
  };
}

/** Installed before the page opens: on the web the core dials as soon as it watches a file. */
async function installPresence(page: Page): Promise<Presence> {
  if (!onWeb()) {
    const vaultId = (): Promise<string> =>
      page.evaluate(
        () => [...(window as unknown as MockWindow).__mock.vaults.values()][0]!.info.id,
      );
    return {
      members: async (path, list) => {
        await expect
          .poll(() =>
            page.evaluate(
              ([p]) =>
                [...(window as unknown as MockWindow).__mock.presence.watches.keys()].some((k) =>
                  k.endsWith(`\u0000${p}`),
                ),
              [path],
            ),
          )
          .toBe(true);
        const id = await vaultId();
        await page.evaluate(
          ([i, p, l]) => (window as unknown as MockWindow).__mock.presence.members(i, p, l),
          [id, path, list] as [string, string, Person[]],
        );
      },
      move: async (path, sid, pos) => {
        const id = await vaultId();
        await page.evaluate(
          ([i, p, s, o]) => (window as unknown as MockWindow).__mock.presence.move(i, p, s, o),
          [id, path, sid, pos] as [string, string, string, Pos],
        );
      },
      cleared: async (path) => {
        const id = await vaultId();
        await page.evaluate(
          ([i, p]) => (window as unknown as MockWindow).__mock.presence.cleared(i, p),
          [id, path] as [string, string],
        );
      },
      watched: () =>
        page.evaluate(() => (window as unknown as MockWindow).__mock.presence.watches.size),
      sent: () =>
        page.evaluate(() =>
          (window as unknown as MockWindow).__mock.presence.moves.map((m) => m.pos),
        ),
    };
  }

  // The cloud's presence channel is played by the dev server of the E2E build (web/scripts/e2ePresence.mjs): the
  // core runs in a Web Worker, whose WebSocket `page.routeWebSocket` cannot reach. The test is told apart from
  // the others on that server by a cookie of its browser context, which the core's upgrade request carries.
  const session = `t${Math.random().toString(36).slice(2, 12)}`;
  const origin = appOrigin();
  await page.context().addCookies([{ name: 'e2e-presence', value: session, url: origin }]);
  interface Room {
    vault: string;
    file: string;
  }
  interface State {
    sockets: number;
    rooms: Room[];
    received: {
      t: string;
      pos?: { k: string; line?: number; col?: number; x?: number; y?: number };
    }[];
  }
  const state = async (): Promise<State> => {
    const res = await page.request.get(`${origin}/__e2e/presence/state?session=${session}`);
    return (await res.json()) as State;
  };
  const send = async (frame: object): Promise<void> => {
    await page.request.post(`${origin}/__e2e/presence/send?session=${session}`, { data: frame });
  };
  // The core joins a room when the file is watched: the frames go to the rooms it is in.
  const toAll = async (frame: (room: Room) => object): Promise<void> => {
    await expect
      .poll(async () => (await state()).rooms.length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    for (const room of (await state()).rooms) await send(frame(room));
  };
  return {
    members: (_, list) =>
      toAll((room) => ({
        t: 'members',
        room,
        list: list.map((m) => ({ sid: m.sid, user_id: m.userId, name: m.name })),
      })),
    move: (_, sid, pos) =>
      toAll((room) => ({
        t: 'move',
        room,
        sid,
        pos: 'line' in pos ? { k: 'text', ...pos } : { k: 'scene', ...pos },
      })),
    // The server forgets a room by telling the core it is alone in it.
    cleared: (_) => toAll((room) => ({ t: 'members', room, list: [] })),
    watched: async () => (await state()).rooms.length,
    sent: async () =>
      (await state()).received
        .filter((f) => f.t === 'move' && f.pos)
        .map((f) => ({
          kind: f.pos!.k === 'text' ? 'text' : 'scene',
          line: f.pos!.line ?? 0,
          col: f.pos!.col ?? 0,
          x: f.pos!.x ?? 0,
          y: f.pos!.y ?? 0,
        })),
  };
}

async function openShared(page: Page, cloud: Cloud): Promise<Presence> {
  const presence = await installPresence(page);
  await cloud.openVault(page, seed, { open: HOME, link: true, files: FILES });
  // the files of the mock folder show in the explorer once the core tells the UI (on the web they came with the sync)
  if (!onWeb()) await seedVault(page, { files: FILES });
  await expect(page.locator('.tree .node', { hasText: 'Note' })).toBeVisible();
  return presence;
}

const toolbar = (page: Page) => page.locator('.sidebar .toolbar');
const avatars = (page: Page) => toolbar(page).getByTestId('presence-avatar');
const cursors = (page: Page) => page.getByTestId('presence-cursor');
const cursorOf = (page: Page, person: Person) =>
  page.locator(`[data-testid="presence-cursor"][data-sid="${person.sid}"]`);
const open = (page: Page, name: string) => page.locator('.tree .node', { hasText: name }).click();

/** The background of the avatar and of the label of the pointer of a person: one colour. */
async function sameColour(page: Page, person: Person): Promise<void> {
  const avatar = avatars(page).filter({
    has: page.locator(`xpath=self::*[@aria-label="${person.name}"]`),
  });
  const bg = (loc: ReturnType<Page['locator']>) =>
    loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  const fg = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).color);
  const label = cursorOf(page, person).locator('.presence-cursor-label');
  await expect(label).toBeVisible();
  expect(await bg(label)).toBe(await bg(avatar.first()));
  expect(await fg(label)).toBe(await fg(avatar.first()));
  expect(await cursorOf(page, person).getAttribute('data-color')).toBe(
    await avatar.first().getAttribute('data-color'),
  );
}

test('the avatars of the others take the place of the New application button: four, then +N, named', async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Note');
  // there is no button for a new application in the bar (the command stays in the ribbon and the menus)
  await expect(toolbar(page).getByRole('button', { name: 'New application' })).toHaveCount(0);
  await expect(
    page.locator('nav.ribbon').getByRole('button', { name: 'New application' }),
  ).toBeVisible();
  // nobody else: nothing is drawn
  await expect(toolbar(page).getByRole('list', { name: 'People in this file' })).toHaveCount(0);

  await presence.members('Note.md', [ADA]);
  await expect(avatars(page)).toHaveCount(1);
  await expect(avatars(page).first()).toHaveAccessibleName('Ada Lovelace');
  await expect(avatars(page).first()).toHaveText('AL');
  // it is the first thing of the bar, before the sort selector
  const bar = await toolbar(page).evaluate((el) => Array.from(el.children, (c) => c.tagName));
  expect(bar[0]).toBe('UL');

  await presence.members('Note.md', [ADA, BOB, ...MORE]);
  await expect(avatars(page)).toHaveCount(4);
  const more = toolbar(page).getByTestId('avatar-more');
  await expect(more).toHaveText('+2');
  await expect(more).toHaveAttribute('title', '2 more: Ed Poe, Flo Reed');
  // the others keep their own colour, the same on every screen
  await expect(avatars(page).nth(0)).toHaveAttribute('data-user', 'u-ada');

  // somebody leaves: their avatar goes at once; everybody leaves: so does the group
  await presence.members('Note.md', [ADA]);
  await expect(avatars(page)).toHaveCount(1);
  await expect(more).toHaveCount(0);
  await presence.cleared('Note.md');
  await expect(avatars(page)).toHaveCount(0);
});

test('the avatars follow the file in front, and the other files show nobody', async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Note');
  await presence.members('Note.md', [ADA, BOB]);
  await expect(avatars(page)).toHaveCount(2);
  await open(page, 'Other');
  await expect(avatars(page)).toHaveCount(0);
  await open(page, 'Note');
  // the core said nothing more while the other file was in front: it tells again when the file is watched again
  await presence.members('Note.md', [ADA, BOB]);
  await expect(avatars(page)).toHaveCount(2);
});

test('the pointer of another person over a note: Live and Source, with name and the colour of the avatar, gone when they leave', async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Note');
  await expect(page.locator('.note-view .note-header')).toBeVisible();
  await presence.members('Note.md', [ADA, BOB]);
  await expect(avatars(page)).toHaveCount(2);

  await presence.move('Note.md', ADA.sid, { line: 3, col: 7 });
  await expect(cursorOf(page, ADA)).toContainText('Ada Lovelace');
  await expect(cursors(page)).toHaveCount(1); // Bob has not moved
  await sameColour(page, ADA);
  // it is over the note, not in a corner
  const first = await cursorOf(page, ADA).boundingBox();
  const editor = (await page.locator('.note-view').boundingBox())!;
  expect(first!.y).toBeGreaterThan(editor.y);
  expect(first!.x).toBeGreaterThan(editor.x);

  // she goes to another line: the same element moves (80 ms transition), further down
  await presence.move('Note.md', ADA.sid, { line: 5, col: 1 });
  await expect
    .poll(async () => (await cursorOf(page, ADA).boundingBox())!.y)
    .toBeGreaterThan(first!.y);
  await presence.move('Note.md', BOB.sid, { line: 1, col: 3 });
  await expect(cursors(page)).toHaveCount(2);
  await sameColour(page, BOB);

  // the same pointers in the Source editor
  await page.locator('.note-view .mode-toggle').getByRole('button', { name: 'Source' }).click();
  await expect(cursors(page)).toHaveCount(2);
  const inSource = await cursorOf(page, ADA).boundingBox();
  expect(inSource!.y).toBeGreaterThan(editor.y);

  // the layer ignores the mouse, and the label is not read out
  expect(
    await page
      .getByTestId('presence-cursors')
      .first()
      .evaluate((e) => getComputedStyle(e).pointerEvents),
  ).toBe('none');
  expect(await cursorOf(page, ADA).evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');

  // Bob leaves: his pointer goes with him; then everybody
  await presence.members('Note.md', [ADA]);
  await expect(cursors(page)).toHaveCount(1);
  await presence.cleared('Note.md');
  await expect(cursors(page)).toHaveCount(0);
});

test('a pointer is not drawn in the reading view, nor after the file changes', async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Note');
  await presence.members('Note.md', [ADA]);
  await presence.move('Note.md', ADA.sid, { line: 3, col: 2 });
  await expect(cursors(page)).toHaveCount(1);
  await page.locator('.note-view .mode-toggle').getByRole('button', { name: 'Reading' }).click();
  await expect(cursors(page)).toHaveCount(0);
  await expect(avatars(page)).toHaveCount(1); // the avatar stays
  await page.locator('.note-view .mode-toggle').getByRole('button', { name: 'Live' }).click();
  await expect(cursors(page)).toHaveCount(1);
  await open(page, 'Other'); // another file: nothing of the first one
  await expect(cursors(page)).toHaveCount(0);
  await expect(avatars(page)).toHaveCount(0);
});

test("what the user's pointer sends is a position of the text, never pixels", async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Note');
  const paragraph = proseMirror(page).getByText('First paragraph of the note.');
  const box = (await paragraph.boundingBox())!;
  // nobody to tell: nothing is sent while the file is alone
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.waitForTimeout(150);
  expect(await presence.sent()).toEqual([]);
  // with another person in the file, the pointer is sent
  await presence.members('Note.md', [ADA]);
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await expect.poll(async () => (await presence.sent()).length).toBeGreaterThan(0);
  const sent = (await presence.sent()).at(-1)!;
  expect(sent.kind).toBe('text');
  expect(sent.line).toBe(3); // "First paragraph of the note." is line 3 of the file
  expect(sent.col).toBeGreaterThan(1);
  // not the screen: the same place sent after a resize of the window is the same line
  await page.setViewportSize({ width: 1100, height: 700 });
  const again = (await paragraph.boundingBox())!;
  await page.mouse.move(again.x + 20, again.y + again.height / 2);
  await page.mouse.move(again.x + 60, again.y + again.height / 2);
  await expect.poll(async () => (await presence.sent()).at(-1)!.line).toBe(sent.line);
  // it is throttled: a burst of moves is a few messages, not one per event
  const before = (await presence.sent()).length;
  for (let i = 0; i < 40; i++) await page.mouse.move(again.x + 10 + i, again.y + again.height / 2);
  await page.waitForTimeout(150);
  expect((await presence.sent()).length - before).toBeLessThan(25);
});

test('the pointer of another person over a drawing: in scene coordinates, with name and colour', async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Sketch');
  await expect(page.locator('.drawing-canvas canvas').first()).toBeVisible({ timeout: 60_000 });
  await presence.members('Sketch.excalidraw', [ADA]);
  await expect(avatars(page)).toHaveCount(1);
  await presence.move('Sketch.excalidraw', ADA.sid, { x: 100, y: 80 });
  await expect(cursorOf(page, ADA)).toContainText('Ada Lovelace');
  await sameColour(page, ADA);
  const at = await cursorOf(page, ADA).boundingBox();
  // another point of the scene, further right and down: drawn there
  await presence.move('Sketch.excalidraw', ADA.sid, { x: 300, y: 280 });
  await expect
    .poll(async () => (await cursorOf(page, ADA).boundingBox())!.x)
    .toBeGreaterThan(at!.x + 100);

  // the pointer of the user is sent as a point of the scene
  const canvas = (await page.locator('.drawing-canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 200, canvas.y + 200);
  await page.mouse.move(canvas.x + 260, canvas.y + 240);
  await expect.poll(async () => (await presence.sent()).at(-1)?.kind).toBe('scene');

  await presence.cleared('Sketch.excalidraw');
  await expect(cursors(page)).toHaveCount(0);
});

test('the pointer of another person over a canvas: world coordinates through the pan and zoom', async ({
  page,
  cloud,
}) => {
  const presence = await openShared(page, cloud);
  await open(page, 'Map');
  await expect(page.locator('[data-node="a"]')).toBeVisible();
  await presence.members('Map.canvas', [ADA]);
  await presence.move('Map.canvas', ADA.sid, { x: 100, y: 50 });
  await expect(cursorOf(page, ADA)).toContainText('Ada Lovelace');
  await sameColour(page, ADA);
  // the pointer is on the card it points to: the world point (100, 50) is inside the node at (0,0) of 200x100
  const card = (await page.locator('[data-node="a"]').boundingBox())!;
  const pointer = (await cursorOf(page, ADA).boundingBox())!;
  expect(pointer.x).toBeGreaterThan(card.x);
  expect(pointer.x).toBeLessThan(card.x + card.width);
  expect(pointer.y).toBeGreaterThan(card.y);
  expect(pointer.y).toBeLessThan(card.y + card.height);

  // panning the board carries the pointer with the document
  const board = (await page.locator('.cv-board').boundingBox())!;
  await page.mouse.move(board.x + board.width - 80, board.y + board.height - 60);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width - 180, board.y + board.height - 20, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await cursorOf(page, ADA).boundingBox())!.x)
    .toBeLessThan(pointer.x - 50);
  await page.waitForTimeout(250); // the 80 ms transition of the pointer is over
  const moved = (await page.locator('[data-node="a"]').boundingBox())!;
  const after = (await cursorOf(page, ADA).boundingBox())!;
  expect(after.x - moved.x).toBeCloseTo(pointer.x - card.x, -1);

  // what the user's pointer sends is a world point (the pan does not change it)
  await page.mouse.move(moved.x + 100, moved.y + 50);
  await page.mouse.move(moved.x + 110, moved.y + 55);
  await expect.poll(async () => (await presence.sent()).at(-1)?.kind).toBe('scene');
  const sent = (await presence.sent()).at(-1)!;
  expect(sent.x).toBeGreaterThan(90);
  expect(sent.x).toBeLessThan(130);

  await presence.cleared('Map.canvas');
  await expect(cursors(page)).toHaveCount(0);
});

test('nothing is watched or drawn when the profile turns presence off', async ({ page, cloud }) => {
  const presence = await installPresence(page);
  if (onWeb()) {
    // the profile of the cloud has the flag off from the start: the core says `disabled` and never dials
    await cloud.openVault(
      page,
      { ...seed, config: { config: { features: { presence: false } } } },
      { open: HOME, link: true, files: FILES },
    );
    await open(page, 'Note');
    await expect(page.locator('.note-view .note-header')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await presence.watched()).toBe(0);
    await expect(avatars(page)).toHaveCount(0);
    return;
  }
  // on the desktop the profile changes while the file is on screen: the core sends the new configuration
  await cloud.openVault(page, seed, { open: HOME, link: true, files: FILES });
  await seedVault(page, { files: FILES });
  await open(page, 'Note');
  await presence.members('Note.md', [ADA]);
  await expect(avatars(page)).toHaveCount(1);
  await presence.move('Note.md', ADA.sid, { line: 3, col: 2 });
  await expect(cursors(page)).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as unknown as { __mock: { emit(n: string, p: unknown): void } };
    w.__mock.emit('config:updated', {
      managed: true,
      version: 2,
      config: {},
      lockedKeys: [],
      features: { presence: false },
    });
  });
  await expect(avatars(page)).toHaveCount(0);
  await expect(cursors(page)).toHaveCount(0);
  await expect.poll(() => presence.watched()).toBe(0);
});

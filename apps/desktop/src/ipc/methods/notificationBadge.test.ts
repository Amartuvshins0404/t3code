import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

const native = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  setOverlayIcon: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getFocusedWindow: vi.fn(() => null as object | null),
  image: { isEmpty: vi.fn(() => false) },
  createFromDataURL: vi.fn(),
  webContents: { send: vi.fn() },
  listeners: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  app: {
    setBadgeCount: native.setBadgeCount,
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getFocusedWindow: native.getFocusedWindow,
    getAllWindows: () => [native],
  },
  nativeImage: { createFromDataURL: native.createFromDataURL },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installNotificationBadge } from "./notificationBadge.ts";

const badge = { count: 2, image: "data:image/png;base64,aGVsbG8=" };
const event = { sender: { id: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  native.getFocusedWindow.mockReturnValue(null);
  native.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromDataURL.mockReturnValue(native.image);
  native.setBadgeCount.mockImplementation(() => true);
  native.listeners.clear();
});

const runInstalled = (
  platform: NodeJS.Platform,
  body: (handler: DesktopIpc.DesktopIpcHandleListener) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installNotificationBadge();
        yield* body(handlers.get("desktop:set-notification-badge")!);
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide([
        ElectronApp.layer,
        DesktopIpc.layerTest({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    expect(native.listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  });

const send = (handler: DesktopIpc.DesktopIpcHandleListener, payload: unknown) =>
  Effect.promise(() => Promise.resolve(handler(event, payload)));

it.effect(
  "validates IPC, keeps the count while a window is focused, and clears on quit and disposal",
  () =>
    Effect.gen(function* () {
      yield* runInstalled("linux", (handler) =>
        Effect.gen(function* () {
          for (const invalid of [
            { ...badge, count: -1 },
            { ...badge, count: 0.5 },
            { ...badge, count: Infinity },
            { ...badge, image: "https://example.com/icon.png" },
            { ...badge, image: `data:image/png;base64,${"a".repeat(16_384)}` },
          ]) {
            yield* Effect.promise(() => expect(handler(event, invalid)).rejects.toBeDefined());
          }
          expect(native.setBadgeCount).not.toHaveBeenCalled();
          yield* send(handler, badge);
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
          native.getFocusedWindow.mockReturnValue({});
          native.listeners.get("browser-window-focus")?.();
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
          yield* send(handler, { ...badge, count: 3 });
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(3);
          yield* send(handler, { count: 0, image: null });
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
          yield* send(handler, badge);
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
          native.listeners.get("before-quit")!();
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
          yield* send(handler, badge);
        }),
      );
      expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
    }),
);

it.effect("labels the Windows overlay with how many threads need you, also while focused", () =>
  Effect.gen(function* () {
    native.getFocusedWindow.mockReturnValue({});
    yield* runInstalled("win32", (handler) =>
      Effect.gen(function* () {
        yield* send(handler, { ...badge, count: 3 });
        expect(native.setOverlayIcon).toHaveBeenLastCalledWith(native.image, "3 threads need you");
        native.listeners.get("browser-window-focus")?.();
        expect(native.setOverlayIcon).toHaveBeenLastCalledWith(native.image, "3 threads need you");
        yield* send(handler, { count: 0, image: null });
        expect(native.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
        yield* send(handler, { ...badge, count: 1 });
        native.listeners.get("before-quit")!();
        expect(native.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
      }),
    );
    expect(native.setBadgeCount).not.toHaveBeenCalled();
  }),
);

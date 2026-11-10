import { compose, pack, type Packed, type ScanRequest } from './scan.ts';

/**
 * Reads the recorded frames off the main thread. The page says which frames it
 * has already loaded, so each one comes from the browser's cache, and asks for a
 * scan line whenever the line, the session or the view changes.
 */
interface Setup { type: 'setup'; scale: number; step: number; base: string }
interface Have { type: 'have'; names: string[] }
interface Scan extends ScanRequest { type: 'scan' }
type Message = Setup | Have | Scan;

const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<Message>) => void) | null };
const frames = new Map<string, Packed>();
const asked = new Set<string>();
const queue: string[] = [];
let scale = 2;
let step = 2;
let base = '';
let busy = 0;
let canvas: OffscreenCanvas | null = null;
let pending: Scan | null = null;

async function read(name: string): Promise<void> {
  const response = await fetch(`${base}frames/${name}.webp`, { cache: 'force-cache' });
  if (!response.ok) throw new Error(String(response.status));
  const bitmap = await createImageBitmap(await response.blob());
  canvas ??= new OffscreenCanvas(bitmap.width, bitmap.height);
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  frames.set(name, pack(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, step));
}

function pump(): void {
  // One at a time, because the frames share one canvas for reading back.
  if (busy || !queue.length) return;
  const name = queue.shift()!;
  busy += 1;
  read(name).then(() => scope.postMessage({ type: 'frame', name }), () => {
    // Forgotten, so the page can ask again when the frame next loads.
    asked.delete(name);
  }).finally(() => {
    busy -= 1;
    pump();
  });
}

function answer(): void {
  if (!pending) return;
  const request = pending;
  pending = null;
  const result = compose(frames, request, scale, step);
  scope.postMessage({ type: 'scan', ...result }, [result.good, result.bad]);
}

scope.onmessage = (e) => {
  const message = e.data;
  if (message.type === 'setup') {
    ({ scale, step, base } = message);
  } else if (message.type === 'have') {
    for (const name of message.names) {
      if (asked.has(name)) continue;
      asked.add(name);
      queue.push(name);
    }
    pump();
  } else {
    // Only the newest request matters. An older one still waiting is dropped.
    const idle = !pending;
    pending = message;
    if (idle) setTimeout(answer, 0);
  }
};

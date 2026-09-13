import { mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const destination = path.resolve('public/vad');
await mkdir(destination, { recursive: true });
for (const name of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) {
  await copyFile(path.resolve('node_modules/@ricky0123/vad-web/dist', name), path.join(destination, name));
}
for (const name of await readdir('node_modules/onnxruntime-web/dist')) {
  if (name.startsWith('ort-wasm-') && /\.(wasm|mjs)$/.test(name)) {
    await copyFile(path.resolve('node_modules/onnxruntime-web/dist', name), path.join(destination, name));
  }
}

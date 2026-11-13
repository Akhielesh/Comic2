import { applyPalette, GIFEncoder, quantize } from 'gifenc';

const encoder = GIFEncoder();

self.onmessage = ({ data }: MessageEvent<{ pixels: ImageData } | { finish: true }>) => {
  try {
    if ('finish' in data) {
      encoder.finish();
      self.postMessage({ blob: new Blob([encoder.bytes()], { type: 'image/gif' }) });
      return;
    }
    const { pixels } = data;
    const palette = quantize(pixels.data, 256);
    encoder.writeFrame(applyPalette(pixels.data, palette), pixels.width, pixels.height, {
      palette,
      delay: 1500,
      repeat: 0
    });
    self.postMessage({});
  } catch {
    self.postMessage({ error: 'The GIF encoder couldn’t process this comic.' });
  }
};

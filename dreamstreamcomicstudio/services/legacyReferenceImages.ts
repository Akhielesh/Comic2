// Legacy editor files are decoded and prepared before uploading a storage object or paying for layout analysis.
import { prepareImageFile } from '../components/comicstudio/refs/downscale';

export async function readLegacyReference(file: File): Promise<string> {
  const { blob } = await prepareImageFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(blob);
  });
}

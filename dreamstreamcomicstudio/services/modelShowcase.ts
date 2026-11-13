import { get } from './apiClient';
import type { ModelShowcaseResponse } from '../shared/modelShowcase';

export async function fetchModelShowcase(signal?: AbortSignal): Promise<ModelShowcaseResponse> {
  const result = await get<ModelShowcaseResponse>('/api/models/showcase', { signal });
  if (!result || !Array.isArray(result.rows)) throw new Error('The image comparison could not be loaded.');
  return result;
}

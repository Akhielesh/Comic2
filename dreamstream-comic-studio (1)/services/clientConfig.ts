export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export const buildApiUrl = (path: string) => {
  if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
  return `${API_BASE_URL}${path}`;
};

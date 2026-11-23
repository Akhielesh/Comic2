// Each extension is one normal 15-minute idle window, at most three after the first.
export async function extendForStudioWork(extensions: number, probe: () => Promise<Response>): Promise<boolean> {
  if (extensions >= 3) return false;
  try { return (await probe()).status === 204; }
  catch { return false; }
}
